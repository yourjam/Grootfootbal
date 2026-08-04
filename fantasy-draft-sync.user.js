// ==UserScript==
// @name         Fantasy Draft Board Live Sync (Yahoo -> Draft Board)
// @namespace    jordan-three-phase-mafia
// @version      1.6
// @description  No-OAuth, no-secrets bridge: reads picks off Yahoo's live draft page you're already logged into, and mirrors them into the draft board tab. Also works as a manual "click to log a pick" helper if auto-detection misses one.
// @match        https://football.fantasysports.yahoo.com/*
// @match        https://yourjam.github.io/Grootfootbal/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
  HOW THIS WORKS (v1.2 — rewritten against a REAL live Yahoo draft room, not guesses)
  -------------------------------------------------------------------------------------
  There is no Yahoo API key, no OAuth, no login automation here on purpose — Yahoo's Fantasy
  API requires a confidential client secret that can't safely live in a public static site, so
  this script instead just reads the same authenticated page you're already looking at in your
  own browser and relays it to the other tab, entirely locally via Tampermonkey's GM storage
  (which is shared across origins for one script install, unlike normal page storage).

  What changed from v1.1: v1.1 could see Yahoo's real-time WebSocket traffic (that part worked)
  but Yahoo's draft socket uses a compact pipe-delimited protocol like "D|3|3|30" and
  "0|2|40055|2|RB|0" — NOT JSON — so the old JSON.parse-based parser silently dropped every
  single message. Decoding that protocol would require mapping Yahoo's internal numeric player
  IDs (e.g. 40055) back to names, which isn't reliable without their private player database.

  Instead, v1.2 reads the "Last: <Player> (POS · Team)" banner that Yahoo's own draft room UI
  already renders in the top-left corner on every pick — confirmed against a real 14-team mock
  draft room (names like "Jahmyr Gibbs", "Bijan Robinson" showed up correctly). This banner:
    - is visible regardless of which inner tab (Players/Board/Results) you're on
    - gives the pick in an ABBREVIATED first-name form, e.g. "J. Smith-Njigba" — the draft
      board's matching logic (see syncPickFromExternal in draft_board.html) was updated to
      handle this via first-initial + last-name matching, tested against 9 real picks pulled
      from that same mock draft (all 9 matched correctly)
    - is polled every ~1.2s, PLUS re-checked immediately whenever the WebSocket reports a
      "D|..." pick-advanced frame, so detection is fast without hammering the DOM

  Two halves, selected automatically by which site you're on:
    1. On football.fantasysports.yahoo.com (your live draft room): watches the "Last:" banner
       and writes new picks to GM storage. A small floating manual-entry panel is always
       available as a fallback if a pick is ever missed.
    2. On the draft board (yourjam.github.io/Grootfootbal): polls GM storage for new picks and
       calls the board's existing draftPlayer() logic directly (via unsafeWindow) to check them
       off, exactly like clicking "Mine" / "Off board" yourself.

  v1.3 fix: live-tested v1.2 in a real mock draft and found "isMe" detection was broken — the
  banner shows your real account name ("Jordan"), not the literal string "You", so every one of
  your own picks was being logged as someone else's and never credited to "My Team" on the
  board. Fixed by cross-checking Yahoo's own "YOUR TEAM (n/15)" panel instead, which lists your
  drafted players by name — confirmed correct in the same live draft (Jahmyr Gibbs now shows
  up as mine).

  v1.5 fix: the "KNOWN LIMITATION" below turned out to be a real, confirmed miss, not just a
  theoretical one — caught live in a 14-team mock where a pick landed and was never detected by
  the banner at all (silently skipped, board and Yahoo's own Players-tab search both kept
  showing the player as available for the rest of the draft). Root cause: the "Last:" banner
  only ever holds the single most-recent pick, so if two picks land within the same ~1.2s poll
  window, the earlier one is gone by the time the next poll checks. Fixed with a second,
  independent detection path: every ~20s, briefly flips to the draft room's "Board" tab (which
  renders the FULL pick history, not just the latest pick — each cell has a title attribute like
  "Harold Fannin Jr., Cle-TE, 6.10" with name/team/position/pick-number all in one string),
  scrapes every pick cell, queues anything the banner path hasn't already caught, then flips
  back to the Players tab so your view isn't disrupted. This runs alongside the fast banner
  poll, not instead of it — the banner path is still primary/instant, this is just a slower
  safety net that guarantees nothing gets permanently missed even if two picks land back to back.
*/

(function () {
  "use strict";

  const STORE_KEY = "ffdb_sync_picks_v1";
  const SEEN_KEY = "ffdb_sync_seen_v1";
  const isYahoo = location.hostname.includes("fantasysports.yahoo.com");
  const isBoard = location.hostname.includes("github.io");

  function getQueue() {
    try { return JSON.parse(GM_getValue(STORE_KEY, "[]")); } catch (e) { return []; }
  }
  // Dedup key is the player name alone — a player can only be legitimately drafted once in a
  // real draft, so this is simpler and more robust than trying to track pick numbers.
  function pushPick(pick) {
    const q = getQueue();
    const dupe = q.some(p => p.name === pick.name);
    if (dupe) return false;
    q.push(pick);
    GM_setValue(STORE_KEY, JSON.stringify(q));
    console.log("[FFDB sync] queued pick:", pick);
    return true;
  }

  function makeDebugPanel(label) {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:999999;background:#0b1120;color:#f1f5f9;border:1px solid #334155;border-radius:8px;padding:8px 10px;font:12px/1.4 -apple-system,sans-serif;max-width:320px;max-height:220px;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,.4);";
    el.innerHTML = `<b style="color:#fbbf24;">${label}</b><div id="ffdb-log"></div>`;
    document.body.appendChild(el);
    return {
      log(msg) {
        const log = el.querySelector("#ffdb-log");
        const line = document.createElement("div");
        line.textContent = msg;
        log.prepend(line);
        while (log.children.length > 12) log.removeChild(log.lastChild);
      }
    };
  }

  // ---------------- YAHOO SIDE ----------------
  if (isYahoo) {
    // GM storage is shared across every page this script matches, indefinitely — it does NOT
    // reset per draft. Discovered via testing: running two mock drafts back-to-back caused the
    // second one's picks to be silently dropped, because early-round players (Bijan Robinson,
    // Jahmyr Gibbs, etc.) are near-identical across mocks and the dedupe-by-name queue from
    // draft #1 was still sitting there blocking them in draft #2. Not a real-draft-day problem
    // (you only run the real draft once), but cheap to guard against: detect the draft room's
    // ID from the URL, and wipe the queue whenever it changes.
    const draftIdMatch = location.pathname.match(/\/draftclient\/f1\/(\d+)\//);
    const currentDraftId = draftIdMatch ? draftIdMatch[1] : null;
    if (currentDraftId) {
      const lastDraftId = GM_getValue("ffdb_sync_draftid_v1", null);
      if (lastDraftId !== currentDraftId) {
        GM_setValue(STORE_KEY, "[]");
        GM_setValue(SEEN_KEY, "[]");
        GM_setValue("ffdb_sync_draftid_v1", currentDraftId);
        console.log("[FFDB sync] New draft room (" + currentDraftId + ") — cleared sync queue left over from a previous draft.");
      }
    }

    const panel = makeDebugPanel("Draft sync: watching Yahoo…");

    // Reads the "Last: <Name> (POS · Team)" banner Yahoo renders in the draft room header.
    // Re-queries fresh every call rather than caching a node reference, since Yahoo's React
    // app can replace this subtree wholesale on re-render.
    function readLastPickBanner() {
      const spans = Array.from(document.querySelectorAll("span"));
      const labelSpan = spans.find(s => s.children.length === 0 && s.textContent.trim() === "Last:");
      if (!labelSpan) return null;
      const infoDiv = labelSpan.parentElement;
      if (!infoDiv || infoDiv.children.length < 3) return null;
      const nameSpan = infoDiv.children[1];
      const posTeamSpan = infoDiv.children[2];
      const name = (nameSpan.textContent || "").trim();
      if (!name) return null;
      let pos = null, team = null;
      const m = (posTeamSpan.textContent || "").match(/\(([^·]+)·\s*([^)]+)\)/);
      if (m) { pos = m[1].trim(); team = m[2].trim(); }
      let draftingTeam = "Unknown";
      const rowDiv = infoDiv.parentElement;
      if (rowDiv && rowDiv.children.length > 1) {
        const t = (rowDiv.children[1].textContent || "").trim();
        if (t) draftingTeam = t;
      }
      return { name, pos, team, draftingTeam };
    }

    // Whether a pick is "mine" can't be read off the "Last:" banner's team name — confirmed
    // live that Yahoo shows your REAL account display name there (e.g. "Jordan"), not the
    // literal string "You", so comparing against "You" silently misses every one of your own
    // picks. Instead, check Yahoo's own "YOUR TEAM (n/15)" roster panel, which lists your
    // drafted players by the same abbreviated name format as the banner — if the just-picked
    // name shows up there, it's yours.
    function findYourTeamPanel() {
      const all = Array.from(document.querySelectorAll("body *"));
      const hit = all.find(el => el.children.length === 0 && /^YOUR TEAM/i.test((el.textContent || "").trim()));
      if (!hit) return null;
      let panel = hit;
      for (let i = 0; i < 3 && panel.parentElement; i++) panel = panel.parentElement;
      return panel;
    }
    // v1.6 fix: the "Last:" banner already gives names in Yahoo's own abbreviated format
    // ("J. Allen"), which matches the YOUR TEAM panel's format directly. But the new v1.5
    // reconciliation sweep pulls FULL names off the Board tab's title attribute ("Josh Allen"),
    // and panel.textContent.includes("Josh Allen") never matches text that only contains
    // "J. Allen" — so every pick caught by reconciliation (instead of the banner) was silently
    // never credited as mine. Confirmed live: Lamar Jackson, Jaxon Smith-Njigba, Rashee Rice,
    // and De'Von Achane were all correctly detected and drafted, but all four were tagged
    // "other" instead of "mine". Fixed by comparing last names only, which is present in both
    // formats — strips common suffixes (Jr., III, etc.) first so e.g. "Harold Fannin Jr."
    // still matches on "Fannin", not "Jr.".
    function lastNameOf(fullName) {
      const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
      const parts = fullName.trim().split(/\s+/);
      while (parts.length > 1 && suffixes.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ""))) {
        parts.pop();
      }
      return parts[parts.length - 1];
    }
    function isMyPick(name) {
      const panel = findYourTeamPanel();
      if (!panel) return false;
      return panel.textContent.includes(lastNameOf(name));
    }

    function checkForNewPick() {
      const banner = readLastPickBanner();
      if (!banner) return;
      const isMe = isMyPick(banner.name);
      const added = pushPick({
        name: banner.name,
        pos: banner.pos,
        team: isMe ? "Me" : banner.draftingTeam,
        isMe
      });
      if (added) panel.log(`Detected: ${banner.name} (${banner.pos || "?"}) -> ${isMe ? "ME" : banner.draftingTeam}`);
    }

    // Base poll — catches every pick even if WebSocket sniffing below doesn't fire.
    setInterval(checkForNewPick, 1200);
    checkForNewPick();

    // WebSocket sniffing: use as a fast trigger only (not for parsing player data — Yahoo's
    // draft socket protocol is pipe-delimited, not JSON, e.g. "D|3|3|30" fires right when a
    // pick lands). IMPORTANT: must patch unsafeWindow, not window — Tampermonkey runs in an
    // isolated JS world, so patching plain `window.WebSocket` never sees the page's real
    // socket traffic. (This was the root cause of v1.0 detecting nothing at all.)
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const OrigWebSocket = pageWindow.WebSocket;
    if (OrigWebSocket) {
      function PatchedWebSocket(url, protocols) {
        const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
        console.log("[FFDB sync] WebSocket opened:", url);
        ws.addEventListener("message", (ev) => {
          if (typeof ev.data === "string" && /^D\|/.test(ev.data)) {
            // "pick advanced" frame — re-check the banner right away instead of waiting for
            // the next poll tick.
            setTimeout(checkForNewPick, 150);
          }
        });
        return ws;
      }
      PatchedWebSocket.prototype = OrigWebSocket.prototype;
      Object.setPrototypeOf(PatchedWebSocket, OrigWebSocket);
      pageWindow.WebSocket = PatchedWebSocket;
    }

    // ---- Reconciliation sweep (v1.5): safety net for the banner's one-pick-at-a-time blind
    // spot. Reads the Board tab's full grid instead of just the latest pick.
    function findTabByLabel(label) {
      return Array.from(document.querySelectorAll("a,button,div,span"))
        .find(el => el.children.length === 0 && el.textContent.trim() === label);
    }
    function scrapeBoardGrid() {
      const titleRe = /^(.+),\s*([A-Za-z]+)-([A-Za-z\/]+),\s*(\d+\.\d+)$/;
      const cells = Array.from(document.querySelectorAll("[title]"));
      const out = [];
      for (const cell of cells) {
        const t = (cell.getAttribute("title") || "").trim();
        const m = t.match(titleRe);
        if (!m) continue;
        out.push({ name: m[1].trim(), team: m[2].trim(), pos: m[3].trim() });
      }
      return out;
    }
    function reconcileFromBoard() {
      const boardTab = findTabByLabel("Board");
      const playersTab = findTabByLabel("Players");
      if (!boardTab || !playersTab) return; // not in a live draft room right now
      boardTab.click();
      setTimeout(() => {
        const picks = scrapeBoardGrid();
        let newCount = 0;
        for (const pick of picks) {
          const isMe = isMyPick(pick.name);
          const added = pushPick({
            name: pick.name,
            pos: pick.pos,
            team: isMe ? "Me" : "Reconciled (drafting team unknown)",
            isMe
          });
          if (added) {
            newCount++;
            panel.log(`Reconciled (missed by banner): ${pick.name} (${pick.pos}) -> ${isMe ? "ME" : "other"}`);
          }
        }
        playersTab.click();
      }, 350);
    }
    setInterval(reconcileFromBoard, 20000);

    // Manual fallback panel — lets you log a pick by hand if auto-detect ever misses one
    const manual = document.createElement("div");
    manual.style.cssText = "position:fixed;bottom:240px;right:10px;z-index:999999;background:#0b1120;border:1px solid #334155;border-radius:8px;padding:8px;";
    manual.innerHTML = `<input id="ffdb-manual-name" placeholder="Player name" style="width:160px;">
      <select id="ffdb-manual-who"><option value="other">Other team</option><option value="mine">Me</option></select>
      <button id="ffdb-manual-btn">Log pick</button>`;
    document.body.appendChild(manual);
    manual.querySelector("#ffdb-manual-btn").onclick = () => {
      const name = manual.querySelector("#ffdb-manual-name").value.trim();
      if (!name) return;
      const who = manual.querySelector("#ffdb-manual-who").value;
      pushPick({ name, team: who === "mine" ? "Me" : "Unknown", isMe: who === "mine" });
      panel.log("Manually logged: " + name);
      manual.querySelector("#ffdb-manual-name").value = "";
    };

    panel.log("Watching the \"Last pick\" banner every 1.2s (+ instant on WS pick events).");
  }

  // ---------------- DRAFT BOARD SIDE ----------------
  if (isBoard) {
    const panel = makeDebugPanel("Draft sync: connected to board");
    const applied = new Set(JSON.parse(GM_getValue(SEEN_KEY, "[]")));

    function poll() {
      const uw = unsafeWindow;
      if (!uw || typeof uw.syncPickFromExternal !== "function") {
        panel.log("Board script not ready yet…");
        return;
      }
      const queue = getQueue();
      let appliedCount = 0;
      for (const pick of queue) {
        const key = pick.name;
        if (applied.has(key)) continue;
        const ok = uw.syncPickFromExternal(pick.name, pick.team, !!pick.isMe, pick.pos);
        applied.add(key);
        if (ok) appliedCount++;
      }
      if (appliedCount) {
        GM_setValue(SEEN_KEY, JSON.stringify([...applied]));
        panel.log(`Applied ${appliedCount} new pick(s) from Yahoo tab`);
      }
    }
    setInterval(poll, 1500);
    panel.log("Polling for picks made on the Yahoo tab every 1.5s.");
  }
})();
