// Cragify live QA harness.
//
// Drives the real page in real Chrome over the DevTools protocol and asserts that it
// cannot end up blank, frozen, or stuck on a loading message — under every network
// condition the app actually meets in the field.
//
// The weather panel has broken on the user three separate times, each time in a way that
// only showed up in a browser on a bad network. So the conditions here are produced at
// the Chrome process level with --host-resolver-rules, which applies to the service
// worker's own requests too (CDP's Fetch/Network interception does not).
//
//   node qa/qa.mjs            run every scenario
//   node qa/qa.mjs weather    run scenarios whose name matches "weather"
//   KEEP=1 node qa/qa.mjs     leave the browser profile behind for inspection
//
// Requires: Google Chrome, and Node 18+ (for a global WebSocket and fetch).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(import.meta.dirname, "..");
const PAGE = "grampians-boulders.html";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HTTP_PORT = 8911;
let cdpPortCounter = 9311;
const nextCdpPort = () => ++cdpPortCounter;
const STALL_PORT = 8912;

// Unroutable address: connections hang rather than being refused.
const BLACKHOLE = "10.255.255.1";
// A local socket that completes the TCP handshake and then says nothing. This is the
// nastiest real-world case — and the one that actually hung the page — because the
// connection looks alive, so nothing fails fast.
const STALL = `127.0.0.1:${STALL_PORT}`;

const WEATHER_HOST = "api.open-meteo.com";
const LEAFLET_HOST = "unpkg.com";
const FONTS_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOST = "tile.thunderforest.com";

// ---------------------------------------------------------------- scenarios

// `rules` are --host-resolver-rules MAP entries. EXCLUDE 127.0.0.1 is appended always so
// the local web server stays reachable.
// `deadlineMs` is how long the page gets to reach a settled state.
const SCENARIOS = [
  {
    name: "baseline: everything reachable",
    rules: [],
    reuseProfile: true,
    leaveWarm: true,
    expect: { weather: "data", map: true },
  },
  {
    name: "baseline: second visit (warm worker cache)",
    rules: [],
    reuseProfile: true,
    leaveWarm: true,
    expect: { weather: "data", map: true },
  },
  {
    name: "weather host unreachable, cold cache",
    rules: [`MAP ${WEATHER_HOST} ${BLACKHOLE}`],
    expect: { weather: "error", map: true },
  },
  {
    name: "weather host unreachable, warm cache",
    rules: [`MAP ${WEATHER_HOST} ${BLACKHOLE}`],
    reuseProfile: true,
    expect: { weather: "stale", map: true },
  },
  {
    name: "weather connection stalls (accepts, never replies), cold cache",
    rules: [`MAP ${WEATHER_HOST} ${STALL}`],
    expect: { weather: "error", map: true },
  },
  {
    name: "weather connection stalls, warm cache",
    rules: [`MAP ${WEATHER_HOST} ${STALL}`],
    reuseProfile: true,
    expect: { weather: "stale", map: true },
  },
  {
    name: "Leaflet CDN unreachable (the cascade case)",
    rules: [`MAP ${LEAFLET_HOST} ${BLACKHOLE}`],
    expect: { weather: "data", table: true },
  },
  {
    name: "Leaflet CDN stalls",
    rules: [`MAP ${LEAFLET_HOST} ${STALL}`],
    expect: { weather: "data", table: true },
  },
  {
    name: "Google Fonts unreachable",
    rules: FONTS_HOSTS.map((h) => `MAP ${h} ${BLACKHOLE}`),
    expect: { weather: "data", map: true },
  },
  {
    name: "Google Fonts stalls",
    rules: FONTS_HOSTS.map((h) => `MAP ${h} ${STALL}`),
    expect: { weather: "data", map: true },
  },
  {
    name: "map tiles unreachable",
    rules: [`MAP ${TILE_HOST} ${BLACKHOLE}`],
    expect: { weather: "data", map: true },
  },
  {
    name: "every third party unreachable at once",
    rules: [WEATHER_HOST, LEAFLET_HOST, TILE_HOST, ...FONTS_HOSTS].map((h) => `MAP ${h} ${BLACKHOLE}`),
    expect: { weather: "error", table: true },
  },
  {
    name: "every third party stalls at once",
    rules: [WEATHER_HOST, LEAFLET_HOST, TILE_HOST, ...FONTS_HOSTS].map((h) => `MAP ${h} ${STALL}`),
    expect: { weather: "error", table: true },
  },
  {
    name: "fully offline after a good visit (the drive-to-the-crag case)",
    rules: [WEATHER_HOST, LEAFLET_HOST, TILE_HOST, ...FONTS_HOSTS].map((h) => `MAP ${h} ${BLACKHOLE}`),
    reuseProfile: true,
    expect: { weather: "stale", table: true },
  },
];

// Interaction probes, run in the baseline browser once the page has settled. Each must
// leave the page functional and raise no uncaught exception.
const INTERACTIONS = [
  {
    name: "retry button mashed 10x",
    script: `(async () => {
      for (let i = 0; i < 10; i++) document.querySelector(".wx-retry")?.click();
      return "clicked";
    })()`,
  },
  {
    name: "weather/climbs tabs toggled 20x",
    script: `(() => {
      for (let i = 0; i < 20; i++) {
        document.getElementById("tab-climbs")?.click();
        document.getElementById("tab-weather")?.click();
      }
      return "toggled";
    })()`,
  },
  {
    name: "weather panel scrolled to the bottom repeatedly (infinite scroll)",
    script: `(async () => {
      const b = document.getElementById("wx-body");
      for (let i = 0; i < 25; i++) { b.scrollTop = b.scrollHeight; await new Promise(r => setTimeout(r, 40)); }
      return "days=" + b.querySelectorAll(".wx-day").length;
    })()`,
  },
  {
    name: "spot switched back and forth 20x",
    script: `(() => {
      const btns = document.querySelectorAll("#wx-spots button");
      for (let i = 0; i < 20; i++) btns[i % btns.length]?.click();
      return "spots=" + btns.length;
    })()`,
  },
  {
    name: "grade slider swept across its range",
    script: `(() => {
      const lo = document.getElementById("min-grade"), hi = document.getElementById("max-grade");
      if (!lo || !hi) return "no slider";
      for (let v = 0; v <= 17; v++) {
        lo.value = String(v); lo.dispatchEvent(new Event("input", {bubbles:true}));
        hi.value = String(17 - (v % 18)); hi.dispatchEvent(new Event("input", {bubbles:true}));
      }
      return "rows=" + document.querySelectorAll("#results-body tr").length;
    })()`,
  },
  {
    name: "theme toggled 20x",
    script: `(() => {
      for (let i = 0; i < 20; i++) document.getElementById("theme-toggle")?.click();
      return document.documentElement.dataset.theme || "ok";
    })()`,
  },
  {
    name: "every modal opened and closed",
    script: `(() => {
      const pairs = [["attribution-btn","attribution-close"],["access-link","access-close"],["location-swap-btn","location-close"]];
      for (const [open, close] of pairs) {
        document.getElementById(open)?.click();
        document.getElementById(close)?.click();
      }
      return "cycled";
    })()`,
  },
  {
    name: "all table headers clicked (sort) twice over",
    script: `(() => {
      const ths = document.querySelectorAll("th");
      for (let i = 0; i < 2; i++) ths.forEach(th => th.click());
      return "rows=" + document.querySelectorAll("#results-body tr").length;
    })()`,
  },
  {
    name: "clock advanced a day, then page refocused (date rollover)",
    script: `(() => {
      // The panel refetches when it returns to the foreground on a later date. Fake the
      // date the page thinks it loaded for, then fire the event it listens on.
      if (typeof wxLoadedFor === "undefined") return "no wxLoadedFor";
      wxLoadedFor = "2000-01-01";
      document.dispatchEvent(new Event("visibilitychange"));
      return "fired";
    })()`,
  },
  {
    name: "every map marker clicked",
    script: `(() => {
      const pins = document.querySelectorAll(".leaflet-marker-icon");
      pins.forEach(p => p.click());
      return "pins=" + pins.length;
    })()`,
  },
];

// ---------------------------------------------------------------- plumbing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let httpServer, stallServer;

function startFileServer() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                  ".json": "application/json", ".md": "text/markdown" };
  httpServer = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || PAGE;
    const file = path.join(REPO, rel);
    // Keep the served tree inside the repo.
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file)] || "application/octet-stream",
      // The service worker must be revalidated every load or scenarios bleed together.
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => httpServer.listen(HTTP_PORT, "127.0.0.1", r));
}

function startStallServer() {
  // Accept and hold. Never write a byte, never close.
  stallServer = net.createServer((sock) => { sock.on("error", () => {}); });
  return new Promise((r) => stallServer.listen(STALL_PORT, "127.0.0.1", r));
}

class Chrome {
  static async launch(rules, profileDir) {
    const port = nextCdpPort();
    const args = [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync",
      "--disable-features=Translate,OptimizationHints",
    ];
    if (rules.length) args.push(`--host-resolver-rules=${[...rules, "EXCLUDE 127.0.0.1"].join(",")}`);
    const proc = spawn(CHROME, args, { stdio: "ignore", detached: false });
    // Wait for the debugging endpoint rather than sleeping a fixed amount.
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return new Chrome(proc, port);
      } catch {}
      await sleep(200);
    }
    proc.kill("SIGKILL");
    throw new Error("Chrome did not expose a debugging port");
  }

  constructor(proc, port) { this.proc = proc; this.port = port; }

  async openPage(url) {
    const made = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    const target = await made.json();
    return Session.attach(target.webSocketDebuggerUrl, url);
  }

  // SIGTERM, not SIGKILL: CacheStorage writes are flushed to disk asynchronously, and
  // killing Chrome outright loses them — which silently turns every "warm cache"
  // scenario into a cold one and reports a harness artifact as an app failure.
  async kill() {
    try { this.proc.kill("SIGTERM"); } catch { return; }
    const exited = new Promise((r) => this.proc.once("exit", r));
    await Promise.race([exited, sleep(4000)]);
    try { this.proc.kill("SIGKILL"); } catch {}
  }
}

class Session {
  static async attach(wsUrl, navigateTo) {
    const s = new Session(wsUrl);
    await s.ready;
    await s.send("Runtime.enable");
    await s.send("Log.enable");
    await s.send("Page.enable");
    if (navigateTo) await s.send("Page.navigate", { url: navigateTo });
    return s;
  }

  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.exceptions.push(d.exception?.description || d.text || "unknown exception");
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
      // Network 404s etc. are noise for this suite; only script-level failures matter.
    });
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", rej);
    });
  }

  send(method, params = {}) {
    return new Promise((res) => {
      const i = ++this.id;
      this.pending.set(i, res);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 30000 });
    if (r.result?.exceptionDetails) {
      return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    }
    return { value: r.result?.result?.value };
  }

  close() { try { this.ws.close(); } catch {} }
}

// What state has the weather panel settled into?
const PANEL_PROBE = `(() => {
  const b = document.getElementById("wx-body");
  if (!b) return JSON.stringify({ state: "missing" });
  const text = b.innerText.replace(/\\s+/g, " ").trim();
  const days = b.querySelectorAll(".wx-day").length;
  const stale = !!b.querySelector(".wx-stale");
  const retry = !!b.querySelector(".wx-retry");
  // A staleness banner marked data-updating is mid-refresh, not a settled state.
  const updating = !!b.querySelector(".wx-stale[data-updating]");
  const busy = updating || /Loading forecast|Still trying|checking for a newer/i.test(text);
  const failed = /Couldn.t load the forecast/i.test(text);
  let state = "unknown";
  if (busy) state = "busy";
  else if (days > 0) state = stale ? "stale" : "data";
  else if (failed) state = "error";
  return JSON.stringify({ state, days, stale, retry, busy, failed, text: text.slice(0, 110) });
})()`;

const STRUCTURE_PROBE = `(() => {
  const rows = document.querySelectorAll("#results-body tr").length;
  const mapEl = document.getElementById("map");
  return JSON.stringify({
    tableRows: rows,
    mapPresent: !!mapEl,
    mapRendered: !!mapEl && mapEl.querySelectorAll(".leaflet-tile-pane, .leaflet-pane").length > 0,
    leafletLoaded: typeof window.L !== "undefined",
    bodyText: (document.body.innerText || "").trim().length,
    headerPresent: !!document.getElementById("site-header"),
  });
})()`;

// Wait until the panel leaves its busy state, or the deadline passes.
async function settle(session, deadlineMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < deadlineMs) {
    const r = await session.eval(PANEL_PROBE);
    if (r.value) {
      last = JSON.parse(r.value);
      if (last.state !== "busy" && last.state !== "missing") {
        return { panel: last, tookMs: Date.now() - started };
      }
    }
    await sleep(500);
  }
  return { panel: last, tookMs: Date.now() - started, timedOut: true };
}

// ---------------------------------------------------------------- assertions

function checkScenario(sc, panel, structure, session, tookMs) {
  const fails = [];
  const want = sc.expect || {};

  // The one inviolable rule: it must never be left looking like it is still working.
  if (!panel || panel.state === "missing") fails.push("weather panel element missing");
  else if (panel.busy) fails.push(`still showing a loading message after ${(tookMs / 1000).toFixed(1)}s ("${panel.text}")`);

  if (panel && want.weather) {
    if (want.weather === "data" && panel.state !== "data") {
      fails.push(`expected a live forecast, got "${panel.state}" ("${panel.text}")`);
    }
    if (want.weather === "stale" && panel.state !== "stale") {
      fails.push(`expected the saved forecast with a staleness banner, got "${panel.state}" ("${panel.text}")`);
    }
    if (want.weather === "error") {
      if (panel.state !== "error") fails.push(`expected a clear failure message, got "${panel.state}" ("${panel.text}")`);
      else if (!panel.retry) fails.push("failure message offers no retry");
    }
    // Showing days is only acceptable if their staleness is disclosed.
    if (panel.state === "data" && want.weather === "stale") fails.push("cached forecast shown with no staleness banner");
  }

  // The page as a whole must survive, whatever the network did.
  if (structure) {
    // "Alive" is structural, not a word count: the header chrome is present and the
    // climbs table — which needs no network at all — actually rendered.
    if (!structure.headerPresent) fails.push("site header missing");
    if (structure.tableRows === 0) fails.push("climbs table rendered no rows (script likely died before render)");
    if (want.map && !structure.mapRendered) fails.push("map did not render");
  }

  // A thrown exception in this monolithic script kills everything after it.
  if (session.exceptions.length) {
    fails.push(`uncaught exception(s): ${session.exceptions.slice(0, 3).join(" | ")}`);
  }
  return fails;
}

// ---------------------------------------------------------------- runner

async function waitForWarmCache(session, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const r = await session.eval(`caches.match(wxForecastUrl()).then(h => !!h).catch(() => false)`, true);
    if (r.value === true) return true;
    await sleep(500);
  }
  return false;
}

async function runScenario(sc, profileDir) {
  const chrome = await Chrome.launch(sc.rules, profileDir);
  let session;
  try {
    session = await chrome.openPage(`http://127.0.0.1:${HTTP_PORT}/${PAGE}`);
    // Generous: more than double the app's own ~15s worst case, so a failure here means
    // genuinely stuck rather than merely slow.
    const { panel, tookMs } = await settle(session, sc.deadlineMs || 40000);
    const structRaw = await session.eval(STRUCTURE_PROBE);
    const structure = structRaw.value ? JSON.parse(structRaw.value) : null;
    const fails = checkScenario(sc, panel, structure, session, tookMs);
    if (sc.leaveWarm && !(await waitForWarmCache(session, 15000))) {
      fails.push("worker cache was not warmed within 15s (later warm-cache scenarios would be invalid)");
    }
    return { fails, panel, structure, tookMs, exceptions: [...session.exceptions] };
  } finally {
    session?.close();
    await chrome.kill();
    await sleep(300);
  }
}

async function runInteractions(profileDir) {
  const chrome = await Chrome.launch([], profileDir);
  const results = [];
  let session;
  try {
    session = await chrome.openPage(`http://127.0.0.1:${HTTP_PORT}/${PAGE}`);
    await settle(session, 40000);
    for (const probe of INTERACTIONS) {
      const before = session.exceptions.length;
      const out = await session.eval(probe.script, true);
      await sleep(1200);
      const raised = session.exceptions.slice(before);
      const panelRaw = await session.eval(PANEL_PROBE);
      const panel = panelRaw.value ? JSON.parse(panelRaw.value) : null;
      const structRaw = await session.eval(STRUCTURE_PROBE);
      const structure = structRaw.value ? JSON.parse(structRaw.value) : null;
      const fails = [];
      if (out.error) fails.push(`threw: ${out.error}`);
      if (raised.length) fails.push(`uncaught: ${raised.slice(0, 2).join(" | ")}`);
      if (structure && structure.tableRows === 0) fails.push("climbs table lost its rows");
      if (structure && !structure.headerPresent) fails.push("site header disappeared");
      if (panel && panel.busy) fails.push(`panel left loading ("${panel.text}")`);
      results.push({ name: probe.name, fails, value: out.value });
    }
    // After all that abuse, the page must still be alive and the forecast still shown.
    const finalRaw = await session.eval(PANEL_PROBE);
    const final = finalRaw.value ? JSON.parse(finalRaw.value) : null;
    const structRaw = await session.eval(STRUCTURE_PROBE);
    const structure = structRaw.value ? JSON.parse(structRaw.value) : null;
    const fails = [];
    if (!final || (final.state !== "data" && final.state !== "stale")) {
      fails.push(`forecast not healthy after the interaction run: "${final?.state}" ("${final?.text}")`);
    }
    if (structure && structure.tableRows === 0) fails.push("climbs table empty after the interaction run");
    results.push({ name: "page still healthy after all interactions", fails, value: final?.state });
    return results;
  } finally {
    session?.close();
    await chrome.kill();
  }
}

// Open-Meteo has been observed accepting TCP and then never answering, twice in one day.
// Without this check an upstream outage reports as a wall of app failures, which is how
// you end up distrusting your own test suite.
async function upstreamReachable() {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=-36.97&longitude=142.44&daily=weather_code";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

async function main() {
  const filter = process.argv[2];
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cragify-qa-"));
  if (!fs.existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}`); process.exit(2); }

  await startFileServer();
  await startStallServer();
  const upstream = await upstreamReachable();
  console.log(`Cragify QA — serving ${REPO} on 127.0.0.1:${HTTP_PORT}`);
  console.log(upstream
    ? `Open-Meteo reachable — all scenarios valid\n`
    : `Open-Meteo UNREACHABLE — scenarios needing live data will be skipped, not failed\n`);

  const scenarios = SCENARIOS.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
  // Scenarios that want a warm worker cache reuse the profile of the baseline run, so
  // "warm" means genuinely warmed by a previous visit rather than hand-seeded.
  const sharedProfile = path.join(profileRoot, "shared");
  const results = [];

  for (const sc of scenarios) {
    const needsUpstream = sc.expect?.weather === "data" || sc.expect?.weather === "stale";
    // Re-checked per scenario, not once at startup: Open-Meteo has degraded mid-run
    // before, which turns a healthy app into a page of red crosses.
    if (needsUpstream && !(upstream && await upstreamReachable())) {
      console.log(`• ${sc.name} … SKIP  (needs a reachable Open-Meteo)`);
      results.push({ name: sc.name, fails: [], skipped: true, panel: null, structure: null, tookMs: 0 });
      continue;
    }
    const profile = sc.reuseProfile ? sharedProfile : fs.mkdtempSync(path.join(profileRoot, "p-"));
    process.stdout.write(`• ${sc.name} … `);
    let r;
    try {
      r = await runScenario(sc, profile);
    } catch (err) {
      r = { fails: [`harness error: ${err.message}`], panel: null, structure: null, tookMs: 0 };
    }
    results.push({ name: sc.name, ...r });
    if (r.fails.length === 0) {
      console.log(`PASS  (${(r.tookMs / 1000).toFixed(1)}s, ${r.panel?.state}${r.panel?.days ? `, ${r.panel.days} days` : ""})`);
    } else {
      console.log(`FAIL  (${(r.tookMs / 1000).toFixed(1)}s)`);
      r.fails.forEach((f) => console.log(`        ↳ ${f}`));
    }
  }

  let interactions = [];
  if (!filter || "interactions".includes(filter.toLowerCase())) {
    console.log(`\n• interaction stress (shared profile)`);
    try {
      interactions = await runInteractions(fs.mkdtempSync(path.join(profileRoot, "ix-")));
    } catch (err) {
      interactions = [{ name: "interaction run", fails: [`harness error: ${err.message}`] }];
    }
    for (const r of interactions) {
      if (r.fails.length === 0) console.log(`    PASS  ${r.name}${r.value ? ` → ${r.value}` : ""}`);
      else { console.log(`    FAIL  ${r.name}`); r.fails.forEach((f) => console.log(`            ↳ ${f}`)); }
    }
  }

  const all = [...results, ...interactions];
  const failed = all.filter((r) => r.fails.length);
  const skipped = all.filter((r) => r.skipped);
  console.log(`\n${all.length - failed.length - skipped.length}/${all.length - skipped.length} passed`
    + (skipped.length ? `, ${skipped.length} skipped (upstream down)` : ""));
  if (failed.length) {
    console.log(`\nFailures:`);
    failed.forEach((r) => console.log(`  ✗ ${r.name}\n      ${r.fails.join("\n      ")}`));
  }

  httpServer.close(); stallServer.close();
  if (!process.env.KEEP) fs.rmSync(profileRoot, { recursive: true, force: true });
  else console.log(`\nProfiles kept in ${profileRoot}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
