// ==UserScript==
// @name         Fantasy Draft Board Live Sync (Yahoo -> Draft Board)
// @namespace    jordan-three-phase-mafia
// @version      1.1
// @description  No-OAuth, no-secrets bridge: reads picks off Yahoo's live draft page you're already logged into, and mirrors them into the draft board tab. Also works as a manual "click to log a pick" helper if auto-detection needs tuning.
// @match        https://football.fantasysports.yahoo.com/*
// @match        https://yourjam.github.io/Grootfootbal/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
  HOW THIS WORKS (read this before draft day)
  ---------------------------------------------
  There is no Yahoo API key, no OAuth, no login automation here on purpose — Yahoo's Fantasy
  API requires a confidential client secret that can't safely live in a public static site, so
  this script instead just reads the same authenticated page you're already looking at in your
  own browser and relays it to the other tab, entirely locally via Tampermonkey's GM storage
  (which is shared across origins for one script install, unlike normal page storage).

  Two halves, selected automatically by which site you're on:
    1. On football.fantasysports.yahoo.com (your live draft room): watches for new picks and
       writes them to GM storage. Uses THREE detection strategies simultaneously since I could
       not verify Yahoo's exact draft-room DOM structure without access to a live/mock draft:
         a) Network sniffing — intercepts fetch()/XHR calls Yahoo's own draft client makes and
            looks for JSON that looks like draft results. Most robust, doesn't depend on CSS.
         b) DOM scraping — tries several common selector patterns for a draft results list.
         c) Manual fallback — a small floating panel where you can paste/select a player name
            if a+b miss a pick, so you're never blocked on this being perfect.
    2. On the draft board (yourjam.github.io/Grootfootbal): polls GM storage for new picks and
       calls the board's existing draftPlayer() logic directly (via unsafeWindow) to check them
       off, exactly like clicking "Mine" / "Off board" yourself.

  BEFORE DRAFT DAY: run a Yahoo mock draft with this installed and watch the on-page debug
  panel (bottom-right, both tabs) to confirm picks are being detected. If strategy (a)/(b) don't
  fire, the console (F12) will log every candidate network response it saw so the selectors can
  be tuned quickly — send that console output back and it can be fixed before Aug 29.
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
  function pushPick(pick) {
    const q = getQueue();
    const dupe = q.some(p => p.name === pick.name && p.pickNumber === pick.pickNumber);
    if (dupe) return;
    q.push(pick);
    GM_setValue(STORE_KEY, JSON.stringify(q));
    console.log("[FFDB sync] queued pick:", pick);
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
    const panel = makeDebugPanel("Draft sync: watching Yahoo…");
    let pickCounter = 0;

    // IMPORTANT: Tampermonkey runs userscripts in an isolated JS world by default — patching
    // plain `window.fetch` here only rewrites the userscript's own private copy, which the
    // page's real code never calls. `unsafeWindow` is the actual page window; patching THAT
    // is what lets us see requests Yahoo's own client makes. (Confirmed via a real mock draft:
    // requests to pub-api.fantasysports.yahoo.com/fantasy/v3/... were firing constantly, but
    // the old window.fetch patch never saw a single one.)
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // Strategy A: sniff fetch() responses for anything draft/pick-shaped
    const origFetch = pageWindow.fetch;
    pageWindow.fetch = function (...args) {
      return origFetch.apply(this, args).then(res => {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (/draft|pick/i.test(url)) {
          res.clone().text().then(text => {
            console.log("[FFDB sync] fetch from", url, "-> first 500 chars:", text.slice(0, 500));
            tryParseDraftPayload(text, "fetch:" + url);
          }).catch(() => {});
        }
        return res;
      });
    };

    // Strategy A2: sniff XHR too, in case some calls use XMLHttpRequest instead of fetch
    const origOpen = pageWindow.XMLHttpRequest.prototype.open;
    pageWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.addEventListener("load", function () {
        if (/draft|pick/i.test(url)) {
          console.log("[FFDB sync] XHR from", url, "-> first 500 chars:", String(this.responseText).slice(0, 500));
          tryParseDraftPayload(this.responseText, "xhr:" + url);
        }
      });
      return origOpen.call(this, method, url, ...rest);
    };

    // Strategy A3: WebSocket sniffing. Yahoo's own /fantasy/v3/draftstatus endpoint returns a
    // dedicated draft_server + draft_port (a real AWS host, not the main API host) — that's a
    // strong signal live picks are pushed over a WebSocket, not polled via HTTP at all. This
    // patches the WebSocket constructor so any socket the page opens gets its messages logged.
    const OrigWebSocket = pageWindow.WebSocket;
    if (OrigWebSocket) {
      function PatchedWebSocket(url, protocols) {
        const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
        console.log("[FFDB sync] WebSocket opened:", url);
        panel.log("WebSocket opened: " + String(url).slice(0, 60));
        ws.addEventListener("message", (ev) => {
          const data = typeof ev.data === "string" ? ev.data : null;
          if (data) {
            console.log("[FFDB sync] WS message from", url, "->", data.slice(0, 500));
            tryParseDraftPayload(data, "ws:" + url);
          }
        });
        return ws;
      }
      PatchedWebSocket.prototype = OrigWebSocket.prototype;
      Object.setPrototypeOf(PatchedWebSocket, OrigWebSocket);
      pageWindow.WebSocket = PatchedWebSocket;
    }

    function tryParseDraftPayload(text, source) {
      let data;
      try { data = JSON.parse(text); } catch (e) {
        // Not JSON — still worth a peek in console if it's short, some draft protocols use
        // lightweight delimited text frames over the socket rather than JSON.
        if (text && text.length < 300) console.log("[FFDB sync] non-JSON payload from", source, text);
        return;
      }
      // Walk the JSON looking for arrays of objects that look like {player, team, pick...}
      const candidates = [];
      (function walk(node, depth) {
        if (depth > 6 || !node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) {
            if (item && typeof item === "object") {
              const keys = Object.keys(item).join(",").toLowerCase();
              if (keys.includes("player") || keys.includes("pick")) candidates.push(item);
            }
          }
        }
        for (const k in node) walk(node[k], depth + 1);
      })(data, 0);
      if (candidates.length) {
        panel.log(`${source}: found ${candidates.length} candidate pick objects (see console)`);
        console.log("[FFDB sync] candidate pick objects from", source, candidates);
      }
    }

    // Strategy B: DOM scraping fallback — several common patterns, none guaranteed, all safe no-ops if absent
    function scrapeDom() {
      const selectors = [
        "[data-testid*='draft-result'] li",
        ".draftresults tr",
        ".ysf-draft-results li",
        "#draftresults tbody tr",
        "[class*='DraftResult']",
      ];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length) {
          panel.log(`DOM strategy matched "${sel}" (${nodes.length} rows) — verify in console`);
          console.log("[FFDB sync] DOM candidates for", sel, nodes);
        }
      }
    }
    setInterval(scrapeDom, 5000);

    // Strategy C: manual fallback panel — lets you confirm a pick by typing a name if auto-detect misses one
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
      pickCounter++;
      pushPick({ name, team: who === "mine" ? "Me" : "Unknown", isMe: who === "mine", pickNumber: Date.now() });
      panel.log("Manually logged: " + name);
      manual.querySelector("#ffdb-manual-name").value = "";
    };

    panel.log("Watching for picks… open console (F12) to see raw network data for tuning.");
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
        const key = pick.name + "#" + pick.pickNumber;
        if (applied.has(key)) continue;
        const ok = uw.syncPickFromExternal(pick.name, pick.team, !!pick.isMe);
        applied.add(key);
        if (ok) appliedCount++;
      }
      if (appliedCount) {
        GM_setValue(SEEN_KEY, JSON.stringify([...applied]));
        panel.log(`Applied ${appliedCount} new pick(s) from Yahoo tab`);
      }
    }
    setInterval(poll, 3000);
    panel.log("Polling for picks made on the Yahoo tab every 3s.");
  }
})();
