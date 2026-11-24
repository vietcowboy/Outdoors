// Cragify live QA harness.
//
// Drives the real page in real Chrome over the DevTools protocol and asserts that the
// weather loads — fast, showing the right day — under every condition the app meets in
// the field, and that the page can never end up blank, frozen, or stuck on a loading
// message.
//
//   node qa/qa.mjs                    run everything
//   node qa/qa.mjs midnight           run scenarios whose name matches "midnight"
//   node qa/qa.mjs --target <url>     smoke-test a deployed copy of the page instead
//   KEEP=1 node qa/qa.mjs             keep browser profiles for inspection
//   JOBS=2 node qa/qa.mjs             run fewer browsers at once (default 4)
//
// Requires Google Chrome and Node 22+ (global WebSocket and fetch).
//
// How conditions are produced — see README.md for why each matters:
//  - Network failures at the Chrome process level (--host-resolver-rules), which apply to
//    the service worker's own requests too. CDP's Fetch/Network interception does not.
//  - Open-Meteo is impersonated by a local HTTPS server per scenario, so the forecast is
//    deterministic. A couple of scenarios use the real API, routed to a server that
//    answers (Open-Meteo's Australian server has been intermittently dead).
//  - The forecast snapshot (data/forecast.json) is generated per scenario.
//  - Each scenario chain is served under its own path (/s/<id>/), which gives it its own
//    service worker scope and lets chains run in parallel without sharing state.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promises as dns } from "node:dns";
import { requestFromPage, melbourneToday, serversElsewhere, viaIp } from "../scripts/fetch-forecast.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const PAGE = "grampians-boulders.html";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Every port is assigned by the OS (listen on 0; Chrome on --remote-debugging-port=0), so
// several copies of this suite — and its parallel chains — can never collide.
let HTTP_PORT = 0, STALL_PORT = 0;
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const BLACKHOLE = "10.255.255.1";          // unroutable: connections never complete
let STALL = "";                            // accepts, then says nothing, forever (set at startup)
const WEATHER_HOST = "api.open-meteo.com";
// Open-Meteo's previous-runs API: the same forecast from another server — the page's backup.
const BACKUP_HOST = "previous-runs-api.open-meteo.com";
const FONTS_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const TILE_HOST = "tile.thunderforest.com";
const UNPKG_HOST = "unpkg.com";
const THIRD_PARTIES = [WEATHER_HOST, BACKUP_HOST, TILE_HOST, UNPKG_HOST, ...FONTS_HOSTS];

const HTML = fs.readFileSync(path.join(REPO, PAGE), "utf8");
const { url: FORECAST_URL } = requestFromPage(HTML);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;

// ---------------------------------------------------------------- time

function melbourneWall(t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(t))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
// The instant at which Melbourne's wall clock reads `wall` ("YYYY-MM-DDTHH:MM:SS").
function melbourneInstant(wall) {
  for (const off of [11, 10]) {
    const t = Date.parse(`${wall}Z`) - off * HOUR;
    if (melbourneWall(t) === wall) return t;
  }
  throw new Error(`no such Melbourne time: ${wall}`);
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Replace Date in the page with one running `offset` ms ahead (or behind), still ticking.
const clockShim = (offset) => `(() => {
  const R = Date, OFFSET = ${offset};
  function D(...a) { if (!new.target) return new R(R.now() + OFFSET).toString(); return a.length ? new R(...a) : new R(R.now() + OFFSET); }
  D.prototype = R.prototype; D.now = () => R.now() + OFFSET; D.parse = R.parse; D.UTC = R.UTC;
  Object.setPrototypeOf(D, R); window.Date = D;
})();`;

// ---------------------------------------------------------------- forecasts

// A structurally faithful Open-Meteo response for every spot, around a given Melbourne day.
function synthPayload({ today, pastDays = 2, days = 18, nulls = {} }) {
  const spots = [[-36.94, 142.41], [-37.13, 142.52]];
  return spots.map(([lat, lng]) => {
    const dates = Array.from({ length: days }, (_, i) => addDays(today, i - pastDays));
    const pick = (arr) => dates.map((d, i) => arr[i % arr.length]);
    const daily = {
      time: dates,
      weather_code: pick([1, 3, 61, 0, 2, 80, 95]),
      temperature_2m_max: pick([21.4, 24.1, 17.8, 19.2, 26.5, 15.1, 22.3]),
      temperature_2m_min: pick([8.2, 10.4, 7.1, 6.5, 12.0, 5.8, 9.9]),
      precipitation_sum: pick([0, 0.4, 6.2, 0, 0, 12.5, 2.1]),
      precipitation_probability_max: pick([5, 20, 80, 0, 10, 95, 60]),
      wind_speed_10m_max: pick([14.2, 22.0, 31.5, 9.8, 18.4, 40.1, 25.0]),
      wind_gusts_10m_max: pick([30.1, 45.0, 60.2, 20.3, 35.5, 75.0, 50.4]),
    };
    const hourly = { time: [], precipitation: [], precipitation_probability: [], temperature_2m: [] };
    for (const d of dates) for (let h = 0; h < 24; h++) {
      hourly.time.push(`${d}T${String(h).padStart(2, "0")}:00`);
      hourly.precipitation.push(h % 7 === 3 ? 0.6 : 0);
      hourly.precipitation_probability.push((h * 7) % 100);
      hourly.temperature_2m.push(10 + 8 * Math.sin((h - 6) / 24 * 2 * Math.PI));
    }
    const ti = dates.indexOf(today);
    if (nulls.today && ti >= 0) for (const k of Object.keys(daily)) if (k !== "time") daily[k][ti] = null;
    if (nulls.tail) for (let i = days - nulls.tail; i < days; i++) for (const k of Object.keys(daily)) if (k !== "time") daily[k][i] = null;
    if (nulls.hourly) hourly.precipitation = hourly.precipitation.map((v, i) => (i % 5 ? v : null));
    if (nulls.noHourly) return { latitude: lat, longitude: lng, timezone: "Australia/Melbourne", daily };
    return { latitude: lat, longitude: lng, timezone: "Australia/Melbourne", utc_offset_seconds: 39600, daily, hourly };
  });
}

const snapshotOf = (payload, fetchedAt, url = FORECAST_URL) =>
  JSON.stringify({ v: 1, fetchedAt: new Date(fetchedAt).toISOString(), url, source: "open-meteo", via: "qa", payload });

// The real forecast, fetched once at startup with the same script the deploy runs (it
// routes around a dead Open-Meteo server), plus a server IP known to answer — Chrome's
// live requests are pointed at it in the scenarios that use the real API.
let REAL = null, GOOD_IP = null;
async function fetchReal() {
  const out = path.join(os.tmpdir(), `cragify-qa-real-${process.pid}.json`);
  try {
    execFileSync(process.execPath, [path.join(REPO, "scripts/fetch-forecast.mjs"), "--html", path.join(REPO, PAGE), "--out", out, "--strict"],
      { stdio: "ignore", timeout: 150000 });
    const snap = JSON.parse(fs.readFileSync(out, "utf8"));
    REAL = { payload: snap.payload, fetchedAt: Date.parse(snap.fetchedAt) };
    // A main-API server that answers right now — not just whatever DNS says, which from
    // Australia is the server that keeps going dead.
    const probe = `https://${WEATHER_HOST}/v1/forecast?latitude=-36.97&longitude=142.44&daily=weather_code`;
    const candidates = [...new Set([...(await dns.resolve4(WEATHER_HOST).catch(() => [])), ...(await serversElsewhere(WEATHER_HOST))])];
    for (const ip of candidates) {
      try { await viaIp(probe, ip); GOOD_IP = ip; break; } catch { /* next */ }
    }
  } catch (err) {
    REAL = null;
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// ---------------------------------------------------------------- scenarios
//
// A chain is a list of steps run in order in ONE browser profile and one URL prefix (so
// one service worker and one cache), which is how "warm" scenarios get a cache warmed by
// a genuine earlier visit. Chains run in parallel.
//
// Step fields:
//   snapshot  "fresh" | "missing" | "garbage" | "mismatch" | "stall" | {age: hours} |
//             {payload: {...synth options}, age: hours} | "real"
//   live      "ok" | "stall" | "down" | "real" | {mock: "<hostile mode>"} | {synth: {...}}
//   clock     a Melbourne wall time "YYYY-MM-DDTHH:MM:SS" for the page's clock
//   tz        IANA zone for the device (Emulation.setTimezoneOverride)
//   rules     extra --host-resolver-rules MAP entries
//   serverDown  the site itself unreachable (offline)
//   rev       serve the page and worker from this git revision instead of the working tree
//   leaflet   "missing" | "stall"
//   inject    script run in the page before anything else
//   expect    { weather: "data"|"stale"|"error"|"any", source, today: true, firstPaintMs,
//               table: false, map: true, settledMs }
//   then      async (session, ctx) => [failures]   extra checks after settling

const fresh = { snapshot: "fresh", live: "ok" };
const chains = [];
const chain = (name, ...steps) => chains.push({ name, steps: steps.map((s, i) => ({ ...s, label: steps.length > 1 ? `${name} — step ${i + 1}: ${s.label}` : name })) });

// --- The case that has been failing in the field ---
chain("Open-Meteo's Australian server stalls; snapshot fresh (the real-world outage)",
  { label: "", snapshot: "fresh", live: "stall", expect: { weather: "data", source: "snapshot", today: true, firstPaintMs: 2500 } });
chain("Open-Meteo's Australian server stalls; snapshot fresh; warm second visit",
  { label: "first visit", snapshot: "fresh", live: "stall", expect: { weather: "data", source: "snapshot", today: true } },
  { label: "second visit", snapshot: "fresh", live: "stall", expect: { weather: "data", today: true, firstPaintMs: 2500 } });
chain("Open-Meteo refuses connections; snapshot fresh",
  { label: "", snapshot: "fresh", live: "down", expect: { weather: "data", source: "snapshot", today: true, firstPaintMs: 2500 } });

// --- Open-Meteo's backup host: the same forecast from another server ---
chain("main API stalls, backup healthy, no snapshot",
  { label: "", snapshot: "missing", live: "stall", backup: "ok", expect: { weather: "data", source: "live", today: true, firstPaintMs: 5000 } });
chain("main API refuses connections, backup healthy, no snapshot",
  { label: "", snapshot: "missing", live: "down", backup: "ok", expect: { weather: "data", source: "live", today: true, firstPaintMs: 2500 } });
chain("main API returns garbage, backup healthy, no snapshot",
  { label: "", snapshot: "missing", live: { mock: "garbage" }, backup: "ok", expect: { weather: "data", source: "live", today: true, firstPaintMs: 2500 } });
chain("main API returns a captive-portal page, backup healthy, no snapshot",
  { label: "", snapshot: "missing", live: { mock: "html-200" }, backup: "ok", expect: { weather: "data", source: "live", today: true, firstPaintMs: 2500 } });
chain("main API stalls, backup healthy, snapshot fresh (the backup's fresher answer wins)",
  { label: "", snapshot: "fresh", live: "stall", backup: "ok", expect: { weather: "data", source: "live", today: true, firstPaintMs: 2500 } });
chain("main API healthy, backup stalls (the backup is never needed)",
  { label: "", snapshot: "missing", live: "ok", backup: "stall", expect: { weather: "data", source: "live", today: true, firstPaintMs: 2500, settledMs: 4000 } });
chain("main API and backup both stall, after a good visit",
  { label: "online", ...fresh, warm: true, expect: { weather: "data", today: true } },
  { label: "both stall, no snapshot", snapshot: "missing", live: "stall", expect: { weather: "data", today: true, firstPaintMs: 2500 } });
chain("real backup API (main stalled), no snapshot",
  { label: "", snapshot: "missing", live: "stall", backup: "real", needsReal: true, expect: { weather: "data", source: "live", today: true, firstPaintMs: 9000 } });

// --- Sources, singly and together ---
chain("both sources healthy", { label: "", ...fresh, expect: { weather: "data", today: true, firstPaintMs: 2500 } });
chain("snapshot missing, Open-Meteo healthy", { label: "", snapshot: "missing", live: "ok", expect: { weather: "data", source: "live", today: true } });
chain("snapshot garbage, Open-Meteo healthy", { label: "", snapshot: "garbage", live: "ok", expect: { weather: "data", source: "live", today: true } });
chain("snapshot for a different request (old page version), Open-Meteo healthy",
  { label: "", snapshot: "mismatch", live: "ok", expect: { weather: "data", source: "live", today: true } });
chain("snapshot request stalls, Open-Meteo healthy", { label: "", snapshot: "stall", live: "ok", expect: { weather: "data", source: "live", today: true } });
chain("snapshot missing, Open-Meteo stalls, nothing saved", { label: "", snapshot: "missing", live: "stall", expect: { weather: "error", settledMs: 12000 } });
chain("snapshot stalls, Open-Meteo stalls, nothing saved", { label: "", snapshot: "stall", live: "stall", expect: { weather: "error", settledMs: 12000 } });
chain("snapshot 2 hours old, Open-Meteo stalls (no banner yet)",
  { label: "", snapshot: { age: 2 }, live: "stall", expect: { weather: "data", source: "snapshot", today: true } });
chain("snapshot 5 hours old, Open-Meteo stalls (age shown)",
  { label: "", snapshot: { age: 5 }, live: "stall", expect: { weather: "stale", source: "snapshot", today: true } });
chain("snapshot from yesterday evening, Open-Meteo stalls (lined up by date)",
  { label: "", snapshot: { yesterday: true }, live: "stall", expect: { weather: "stale", source: "snapshot", today: true } });
chain("snapshot ran out three weeks ago, Open-Meteo stalls", { label: "", snapshot: { expired: true }, live: "stall", expect: { weather: "error" } });
chain("snapshot old, Open-Meteo healthy (fresher one wins)",
  { label: "", snapshot: { age: 6 }, live: "ok", expect: { weather: "data", source: "live", today: true } });

// --- The real API, routed to a server that answers ---
chain("real Open-Meteo, no snapshot", { label: "", snapshot: "missing", live: "real", needsReal: true, needsGoodIp: true, expect: { weather: "data", source: "live", today: true } });
chain("real snapshot from the deploy script, Open-Meteo stalls",
  { label: "", snapshot: "real", live: "stall", needsReal: true, expect: { weather: "data", source: "snapshot", today: true } });

// --- Saved copies ---
chain("drive to the crag: good visit, then no network at all",
  { label: "at home", ...fresh, warm: true, expect: { weather: "data", today: true } },
  { label: "no reception, page reopened", serverDown: true, rules: THIRD_PARTIES.map((h) => `MAP ${h} ${BLACKHOLE}`),
    expect: { weather: "data", today: true, map: false } });
chain("good visit; next day the site is reachable but Open-Meteo and the snapshot aren't",
  { label: "at home", ...fresh, warm: true, expect: { weather: "data", today: true } },
  { label: "next day, both stalled", snapshot: "stall", live: "stall", clockAhead: 22 * HOUR,
    expect: { weather: "stale", today: true } });

// --- Time ---
chain("device timezone Los Angeles (a day behind Melbourne)", { label: "", ...fresh, tz: "America/Los_Angeles", expect: { weather: "data", today: true } });
chain("device timezone UTC", { label: "", ...fresh, tz: "UTC", expect: { weather: "data", today: true } });
chain("device timezone Kiritimati (UTC+14, ahead of Melbourne)", { label: "", ...fresh, tz: "Pacific/Kiritimati", expect: { weather: "data", today: true } });
chain("midnight passes while the page is open", {
  label: "", ...fresh, clock: "2026-12-01T23:59:52", expect: { weather: "data" },
  then: async (s, ctx) => {
    // Wait for the page to pass midnight, then compare its "Today" with the date its own clock
    // reads at this moment. (Comparing against a reading taken just before the wait was racy.)
    await sleep(10000);
    await s.eval("wxTick()");
    await sleep(800);
    const after = await panelToday(s);
    const want = melbourneToday(new Date(Date.now() + ctx.st.offset));
    return after === want && after === "2026-12-02" ? [] : [`after midnight "Today" was ${after}, expected ${want}`];
  },
});
chain("new year's eve to new year's day", {
  label: "", ...fresh, clock: "2026-12-31T23:59:54", expect: { weather: "data", today: true },
  then: async (s) => {
    await sleep(8000); await s.eval("wxTick()"); await sleep(800);
    const after = await panelToday(s);
    return after === "2027-01-01" ? [] : [`after midnight "Today" was ${after}, expected 2027-01-01`];
  },
});
chain("daylight saving starts (Melbourne, first Sunday of October)", { label: "", ...fresh, clock: "2026-10-04T08:00:00", expect: { weather: "data", today: true } });
chain("daylight saving ends (Melbourne, first Sunday of April)", { label: "", ...fresh, clock: "2027-04-04T08:00:00", expect: { weather: "data", today: true } });
chain("public holidays in the window: Christmas on a Sunday (2033)", {
  label: "", ...fresh, clock: "2033-12-20T09:00:00", expect: { weather: "data", today: true },
  then: async (s) => {
    const chips = JSON.parse((await s.eval(`(async () => { for (let i = 0; i < 4; i++) { wxShown = 99; wxSafeRender(); } return JSON.stringify([...document.querySelectorAll(".wx-holiday-chip")].map(c => c.closest(".wx-day").querySelector(".wx-hourly").dataset.wxDate + " " + c.textContent)); })()`, true)).value || "[]");
    const want = ["2033-12-25 Christmas Day", "2033-12-26 Boxing Day", "2033-12-27 Christmas Day holiday"];
    const missing = want.filter((w) => !chips.includes(w));
    return missing.length ? [`missing holidays: ${missing.join(", ")} (got ${chips.join("; ")})`] : [];
  },
});

// --- Bad data ---
chain("today has no values at all (nulls)", {
  label: "", snapshot: { payload: { nulls: { today: true } } }, live: "stall", expect: { weather: "data", today: true },
  then: async (s) => {
    const txt = (await s.eval(`document.querySelector(".wx-day:not(.wx-yesterday-card)")?.innerText.replace(/\\s+/g, " ")`)).value || "";
    const fails = [];
    if (/\b0°/.test(txt)) fails.push(`a missing temperature rendered as 0°: "${txt.slice(0, 120)}"`);
    if (/Partly cloudy|Sunny|Cloudy/.test(txt)) fails.push(`a missing weather code rendered as weather: "${txt.slice(0, 120)}"`);
    if (!/No forecast/.test(txt)) fails.push(`no "No forecast" label: "${txt.slice(0, 120)}"`);
    return fails;
  },
});
chain("last days padded with nulls (beyond the models' horizon)", {
  label: "", snapshot: { payload: { nulls: { tail: 4 } } }, live: "stall", expect: { weather: "data", today: true },
  then: async (s) => {
    const n = (await s.eval(`(() => { wxShown = 99; wxSafeRender(); return document.querySelectorAll(".wx-day:not(.wx-yesterday-card)").length; })()`)).value;
    return n === 12 ? [] : [`expected 12 days once the 4 empty ones are dropped, got ${n}`];
  },
});
chain("hourly rainfall with gaps", { label: "", snapshot: { payload: { nulls: { hourly: true } } }, live: "stall", expect: { weather: "data", today: true } });
chain("no hourly data at all", { label: "", snapshot: { payload: { nulls: { noHourly: true } } }, live: "stall", expect: { weather: "data", today: true } });
for (const mode of ["garbage", "truncated", "empty-body", "empty-daily", "no-daily", "one-location", "bad-dates", "html-200", "http-500", "http-429"]) {
  chain(`Open-Meteo returns ${mode}, no snapshot`, { label: "", snapshot: "missing", live: { mock: mode }, expect: { weather: "error" } });
  chain(`Open-Meteo returns ${mode}, snapshot fresh`, { label: "", snapshot: "fresh", live: { mock: mode }, expect: { weather: "data", source: "snapshot", today: true } });
}

// --- The rest of the page failing must not take the weather with it ---
chain("vendored Leaflet missing (404)", { label: "", ...fresh, leaflet: "missing", expect: { weather: "data", today: true } });
chain("vendored Leaflet stalls (weather must not wait for it)", { label: "", ...fresh, leaflet: "stall", expect: { weather: "data", today: true, table: false } });
chain("the main script crashes at startup", {
  label: "", ...fresh, inject: `Object.defineProperty(window, "L", { configurable: true, get() { throw new Error("simulated main-script crash"); } });`,
  allowExceptions: true, expect: { weather: "data", today: true, table: false },
});
chain("Google Fonts stalls", { label: "", ...fresh, rules: FONTS_HOSTS.map((h) => `MAP ${h} ${STALL}`), expect: { weather: "data", today: true, map: true } });
chain("map tiles unreachable", { label: "", ...fresh, rules: [`MAP ${TILE_HOST} ${BLACKHOLE}`], expect: { weather: "data", today: true, map: true } });
chain("every third party stalls at once", { label: "", ...fresh, live: "stall", rules: [TILE_HOST, UNPKG_HOST, ...FONTS_HOSTS].map((h) => `MAP ${h} ${STALL}`),
  expect: { weather: "data", source: "snapshot", today: true } });

// --- Crippled platforms ---
chain("no service worker or CacheStorage (private browsing)", { label: "", ...fresh,
  inject: `Object.defineProperty(navigator, "serviceWorker", { get: () => undefined }); delete window.caches;`, expect: { weather: "data", today: true } });
chain("CacheStorage rejects everything (quota)", { label: "", ...fresh,
  inject: `if (window.caches) { caches.open = () => Promise.reject(new Error("QuotaExceededError")); caches.match = () => Promise.reject(new Error("QuotaExceededError")); }`,
  expect: { weather: "data", today: true } });
chain("localStorage throws", { label: "", ...fresh, inject: `Object.defineProperty(window, "localStorage", { get() { throw new Error("SecurityError"); } });`, expect: { weather: "data", today: true } });
chain("no AbortSignal.timeout (Safari 15), Open-Meteo stalls", { label: "", snapshot: "missing", live: "stall",
  inject: `Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });`, expect: { weather: "error", settledMs: 12000 } });
chain("no Intl time zone support", { label: "", ...fresh,
  inject: `const RealDTF = Intl.DateTimeFormat; Intl.DateTimeFormat = function (l, o) { if (o && o.timeZone) throw new RangeError("unsupported"); return new RealDTF(l, o); };`,
  expect: { weather: "data" } });

// --- Upgrading from every service worker this site has ever shipped ---
// Two visits on the old version first: before c7d0f5f a worker saved nothing on the visit
// that installed it, so the second is what leaves an old-format saved forecast behind.
for (const rev of ["0eb4303", "d21fe7f", "f3ce9af", "7e2aa16", "c7d0f5f"]) {
  chain(`upgrade from the ${rev} worker`,
    { label: `first visit on ${rev}`, rev, snapshot: "fresh", live: "ok", expect: { weather: "any" } },
    // Whether an old worker saved anything is how that version behaved, not what's under
    // test — so it's noted rather than failed. The upgrade itself is the next two steps.
    { label: `second visit on ${rev}`, rev, snapshot: "fresh", live: "ok", warm: "note", expect: { weather: "any" } },
    { label: "visit on the current page", snapshot: "fresh", live: "ok", expect: { weather: "data", today: true } },
    { label: "and again, Open-Meteo stalled", snapshot: "fresh", live: "stall", expect: { weather: "data", today: true, firstPaintMs: 3000 } });
}

// Interaction stress, in one healthy page. Each must leave the page working.
const INTERACTIONS = [
  ["retry from a failure, mashed 10x", `(async () => { wxData = null; wxShowStatus("Couldn’t load the forecast (test).", true);
     for (let i = 0; i < 10; i++) document.querySelector(".wx-retry")?.click(); await new Promise(r => setTimeout(r, 3000));
     return document.querySelectorAll(".wx-day").length ? "recovered" : "NOT RECOVERED: " + document.getElementById("wx-body").innerText.slice(0, 80); })()`],
  ["tabs toggled 20x", `(() => { for (let i = 0; i < 20; i++) { document.getElementById("tab-climbs")?.click(); document.getElementById("tab-weather")?.click(); } return "ok"; })()`],
  ["scrolled to the bottom repeatedly", `(async () => { const b = document.getElementById("wx-body"); for (let i = 0; i < 25; i++) { b.scrollTop = b.scrollHeight; await new Promise(r => setTimeout(r, 40)); } return "days=" + b.querySelectorAll(".wx-day").length; })()`],
  ["spot switched 20x during a reload", `(() => { loadWeather(true); const b = document.querySelectorAll("#wx-spots button"); for (let i = 0; i < 20; i++) b[i % b.length]?.click(); return "spots=" + b.length; })()`],
  ["yesterday card toggled 10x", `(() => { for (let i = 0; i < 10; i++) document.querySelector(".wx-yesterday-toggle")?.click(); return "ok"; })()`],
  ["conditions popover opened on every chart", `(() => { const c = document.querySelectorAll(".wx-hourly"); c.forEach(x => x.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 }))); c.forEach(x => x.click()); return "charts=" + c.length; })()`],
  ["grade slider swept", `(() => { const lo = document.getElementById("min-grade"), hi = document.getElementById("max-grade"); if (!lo || !hi) return "no slider"; for (let v = 0; v <= 17; v++) { lo.value = String(v); lo.dispatchEvent(new Event("input", { bubbles: true })); hi.value = String(17 - v); hi.dispatchEvent(new Event("input", { bubbles: true })); } return "rows=" + document.querySelectorAll("#results-body tr").length; })()`],
  ["theme toggled 20x", `(() => { for (let i = 0; i < 20; i++) document.getElementById("theme-toggle")?.click(); return "ok"; })()`],
  ["every modal opened and closed", `(() => { for (const [o, c] of [["attribution-btn", "attribution-close"], ["location-swap-btn", "location-close"]]) { document.getElementById(o)?.click(); document.getElementById(c)?.click(); } return "ok"; })()`],
  ["every table header clicked twice", `(() => { const t = document.querySelectorAll("th"); for (let i = 0; i < 2; i++) t.forEach(x => x.click()); return "rows=" + document.querySelectorAll("#results-body tr").length; })()`],
  ["every map marker clicked", `(() => { const p = document.querySelectorAll(".leaflet-marker-icon"); p.forEach(x => x.click()); return "pins=" + p.length; })()`],
  ["the tab hidden and shown 20x", `(() => { for (let i = 0; i < 20; i++) document.dispatchEvent(new Event("visibilitychange")); return "ok"; })()`],
  ["reception lost and regained", `(async () => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); await new Promise(r => setTimeout(r, 2500)); return "ok"; })()`],
];

// ---------------------------------------------------------------- serving

const chainState = new Map();   // id -> per-chain serving state
let fileServer, stallServer;

const revCache = new Map();
function fileAt(rev, rel) {
  if (!rev) {
    const p = path.join(REPO, rel);
    return p.startsWith(REPO) && fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p) : null;
  }
  const key = `${rev}:${rel}`;
  if (!revCache.has(key)) {
    try { revCache.set(key, execFileSync("git", ["-C", REPO, "show", key], { maxBuffer: 1 << 26 })); }
    catch { revCache.set(key, null); }
  }
  return revCache.get(key);
}

function snapshotBody(spec, offset) {
  const now = Date.now() + offset;
  const today = melbourneToday(new Date(now));
  if (spec === "fresh") return snapshotOf(synthPayload({ today }), now - 10 * 60e3);
  if (spec === "real") return REAL ? snapshotOf(REAL.payload, REAL.fetchedAt) : null;
  if (spec === "garbage") return "<html>not a forecast</html>";
  if (spec === "mismatch") return snapshotOf(synthPayload({ today }), now - 10 * 60e3, FORECAST_URL.replace("forecast_days=16", "forecast_days=7"));
  if (spec && typeof spec === "object") {
    const base = spec.yesterday ? addDays(today, -1) : spec.expired ? addDays(today, -21) : today;
    const age = spec.yesterday ? 20 : spec.expired ? 21 * 24 : (spec.age ?? 0.2);
    return snapshotOf(synthPayload({ today: base, ...(spec.payload || {}) }), now - age * HOUR);
  }
  return null;
}

function startFileServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  fileServer = createServer((req, res) => {
    const m = req.url.match(/^\/s\/([^/]+)\/([^?]*)/);
    const st = m && chainState.get(m[1]);
    if (!st) { res.writeHead(404); res.end(); return; }
    if (st.serverDown) { req.socket.destroy(); return; }
    const rel = decodeURIComponent(m[2]) || PAGE;
    const send = (status, body, type) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (rel === "data/forecast.json") {
      if (st.snapshot === "stall") return;                       // hold it open forever
      const body = snapshotBody(st.snapshot, st.offset);
      return body == null ? send(404, "not found", "text/plain") : send(200, body, "application/json");
    }
    if (rel.startsWith("vendor/leaflet/") && st.leaflet === "missing") return send(404, "not found", "text/plain");
    if (rel === "vendor/leaflet/leaflet.js" && st.leaflet === "stall") return;
    const isCore = rel === PAGE || rel === "sw.js";
    const body = fileAt(isCore ? st.rev : null, rel);
    if (body == null) return send(404, "not found", "text/plain");
    send(200, body, types[path.extname(rel)] || "application/octet-stream");
  });
  return listen(fileServer).then((p) => { HTTP_PORT = p; });
}

function startStallServer() {
  stallServer = net.createServer((sock) => { sock.on("error", () => {}); });
  return listen(stallServer).then((p) => { STALL_PORT = p; STALL = `127.0.0.1:${p}`; });
}

// A per-chain HTTPS server impersonating Open-Meteo. Self-signed, so the browser runs
// with --ignore-certificate-errors.
let CERT = null;
function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cragify-qa-cert-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "30", "-nodes", "-subj", "/CN=api.open-meteo.com"], { stdio: "ignore" });
  CERT = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
function liveBody(st, spec) {
  const now = Date.now() + st.offset;
  const today = melbourneToday(new Date(now));
  const valid = synthPayload({ today, ...(spec && spec.synth ? spec.synth : {}) });
  const mode = spec && spec.mock;
  switch (mode) {
    case undefined: return [200, JSON.stringify(valid)];
    case "garbage": return [200, "this is not JSON"];
    case "truncated": return [200, JSON.stringify(valid).slice(0, 900)];
    case "empty-body": return [200, ""];
    case "empty-daily": return [200, JSON.stringify(valid.map((l) => ({ ...l, daily: { time: [] } })))];
    case "no-daily": return [200, JSON.stringify(valid.map((l) => ({ latitude: l.latitude })))];
    case "one-location": return [200, JSON.stringify(valid[0])];
    case "bad-dates": return [200, JSON.stringify(valid.map((l) => ({ ...l, daily: { ...l.daily, time: l.daily.time.map((t) => `${t}"><img src=x onerror=alert(1)>`) } })))];
    case "html-200": return [200, "<!doctype html><title>Login to WiFi</title>"];
    case "http-500": return [500, '{"error":true}'];
    case "http-429": return [429, '{"error":true,"reason":"rate limited"}'];
    default: throw new Error(`unknown mock ${mode}`);
  }
}
function startMock(st) {
  const server = https.createServer(CERT, (req, res) => {
    const backup = (req.headers.host || "").startsWith(BACKUP_HOST);
    const [status, body] = liveBody(st, backup ? st.backupLive : st.live);
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(body);
  });
  return listen(server).then((port) => ({ server, port }));
}

// ---------------------------------------------------------------- browser

class Chrome {
  static async launch(profileDir, rules, flags) {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
      "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
      "--disable-features=Translate,OptimizationHints", ...flags];
    if (rules.length) args.push(`--host-resolver-rules=${[...rules, "EXCLUDE 127.0.0.1"].join(",")}`);
    const proc = spawn(CHROME, args, { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
        if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return new Chrome(proc, port);
      } catch {}
      await sleep(200);
    }
    proc.kill("SIGKILL");
    throw new Error("Chrome did not expose a debugging port");
  }
  constructor(proc, port) { this.proc = proc; this.port = port; }
  async open() {
    const t = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    const s = new Session(t.webSocketDebuggerUrl);
    await s.ready;
    await s.send("Runtime.enable");
    await s.send("Page.enable");
    return s;
  }
  // SIGTERM and wait: CacheStorage is flushed asynchronously, and SIGKILL loses it —
  // silently turning every warm-cache step into a cold one.
  async kill() {
    try { this.proc.kill("SIGTERM"); } catch { return; }
    await Promise.race([new Promise((r) => this.proc.once("exit", r)), sleep(5000)]);
    try { this.proc.kill("SIGKILL"); } catch {}
  }
}

class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map(); this.exceptions = [];
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.exceptions.push((d.exception?.description || d.text || "exception").split("\n")[0]);
      }
    });
    this.ready = new Promise((res, rej) => { this.ws.addEventListener("open", res); this.ws.addEventListener("error", rej); });
  }
  send(method, params = {}) {
    return new Promise((res) => { const i = ++this.id; this.pending.set(i, res); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, timeout: 30000 });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
    return { value: r.result?.result?.value };
  }
  close() { try { this.ws.close(); } catch {} }
}

const PANEL_PROBE = `(() => {
  const b = document.getElementById("wx-body");
  if (!b) return JSON.stringify({ state: "missing" });
  const text = b.innerText.replace(/\\s+/g, " ").trim();
  const days = b.querySelectorAll(".wx-day:not(.wx-yesterday-card)").length;
  const todayCard = [...b.querySelectorAll(".wx-day-chip")].find(c => c.textContent === "Today");
  const busyText = /Loading forecast|checking for a newer/i.test(text);
  const loading = typeof wxLoading !== "undefined" ? wxLoading : false;
  const failed = /Couldn.t (load|show) the forecast/i.test(text);
  const stale = !!b.querySelector(".wx-stale");
  let state = "unknown";
  if (days > 0) state = stale ? "stale" : "data";
  else if (busyText) state = "busy";
  else if (failed) state = "error";
  return JSON.stringify({ state, days, stale, loading, busyText, failed,
    retry: !!b.querySelector(".wx-retry"),
    today: todayCard ? todayCard.closest(".wx-day").querySelector(".wx-hourly")?.dataset.wxDate : null,
    source: typeof wxSource !== "undefined" ? wxSource : null,
    text: text.slice(0, 120) });
})()`;
const STRUCTURE_PROBE = `JSON.stringify({ rows: document.querySelectorAll("#results-body tr").length,
  header: !!document.getElementById("site-header"),
  map: !!document.querySelector("#map .leaflet-pane") })`;
const panelToday = async (s) => JSON.parse((await s.eval(PANEL_PROBE)).value).today;

async function probe(s) {
  const r = await s.eval(PANEL_PROBE);
  return r.value ? JSON.parse(r.value) : null;
}

// Watch the panel until it has settled: not busy, and no load in flight. Records when
// the first forecast appeared.
async function watch(s, deadlineMs) {
  const t0 = Date.now();
  let firstPaint = null, last = null;
  while (Date.now() - t0 < deadlineMs) {
    last = await probe(s);
    if (last && last.days > 0 && firstPaint == null) firstPaint = Date.now() - t0;
    if (last && last.state !== "busy" && last.state !== "missing" && last.state !== "unknown" && !last.loading) {
      return { panel: last, settledMs: Date.now() - t0, firstPaint };
    }
    await sleep(100);
  }
  return { panel: last, settledMs: Date.now() - t0, firstPaint, timedOut: true };
}

// ---------------------------------------------------------------- running

async function runChain(c, idx, profileRoot) {
  const id = `c${idx}`;
  const profile = fs.mkdtempSync(path.join(profileRoot, `${id}-`));
  const st = { snapshot: "fresh", live: "ok", offset: 0 };
  chainState.set(id, st);
  const mock = await startMock(st);
  const results = [];
  try {
    for (const step of c.steps) {
      if (step.needsReal && !REAL) { results.push({ name: step.label, skipped: "needs the real Open-Meteo API" }); continue; }
      if (step.needsGoodIp && !GOOD_IP) { results.push({ name: step.label, skipped: "no Open-Meteo main-API server answering" }); continue; }
      Object.assign(st, { snapshot: step.snapshot ?? "fresh", live: step.live ?? "ok", serverDown: !!step.serverDown,
        rev: step.rev || null, leaflet: step.leaflet || null,
        offset: step.clock ? melbourneInstant(step.clock) - Date.now() : (step.clockAhead || 0) });
      const rules = [...(step.rules || [])];
      // How each Open-Meteo host behaves this step. The backup follows the main host unless
      // the step says otherwise, so "Open-Meteo stalls" means all of Open-Meteo stalls.
      st.backupLive = step.backup ?? st.live;
      const mapHost = (host, mode) => {
        if (mode === "stall") return `MAP ${host} ${STALL}`;
        if (mode === "down") return `MAP ${host} 127.0.0.1:1`;
        if (mode === "real") return host === WEATHER_HOST ? `MAP ${host} ${GOOD_IP}` : null;  // backup: real DNS
        return `MAP ${host} 127.0.0.1:${mock.port}`;                                         // healthy or a mock mode
      };
      for (const [host, mode] of [[WEATHER_HOST, st.live], [BACKUP_HOST, st.backupLive]]) {
        const rule = mapHost(host, mode);
        if (rule) rules.push(rule);
      }
      const chrome = await Chrome.launch(profile, rules, ["--ignore-certificate-errors"]);
      let s;
      try {
        s = await chrome.open();
        if (step.tz) await s.send("Emulation.setTimezoneOverride", { timezoneId: step.tz });
        const inject = [st.offset ? clockShim(st.offset) : "", step.inject || ""].filter(Boolean).join("\n");
        if (inject) await s.send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
        await s.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/s/${id}/${PAGE}` });
        const { panel, settledMs, firstPaint, timedOut } = await watch(s, step.expect?.settledMs ? step.expect.settledMs + 4000 : 30000);
        const structure = JSON.parse((await s.eval(STRUCTURE_PROBE)).value || "{}");
        const fails = check(step, panel, structure, s, { settledMs, firstPaint, timedOut, offset: st.offset });
        if (step.then && !fails.length) fails.push(...(await step.then(s, { st })));
        let note = "";
        if (step.warm) {
          const ok = await waitWarm(s, step.rev ? 1 : 2);
          if (!ok && step.warm === "note") note = "old worker saved nothing (as that version did)";
          else if (!ok) fails.push("the worker didn't save a forecast within 20s (later steps would be invalid)");
        }
        results.push({ name: step.label, fails, panel, settledMs, firstPaint, note });
      } finally {
        s?.close();
        await chrome.kill();
      }
    }
  } finally {
    mock.server.close();
    chainState.delete(id);
  }
  return results;
}

// Has the worker saved at least `n` forecasts, in any of the caches this site has used?
// (Earlier workers saved only Open-Meteo's response, under other cache names.)
async function waitWarm(s, n) {
  for (let i = 0; i < 40; i++) {
    const r = await s.eval(`(async () => { try { let k = 0; for (const name of await caches.keys()) if (name.startsWith("cragify-weather")) k += (await (await caches.open(name)).keys()).length; return k >= ${n}; } catch { return false; } })()`, true);
    if (r.value === true) return true;
    await sleep(500);
  }
  return false;
}

function check(step, panel, structure, s, t) {
  const want = step.expect || {};
  const fails = [];
  if (!panel || panel.state === "missing") return ["weather panel missing"];
  if (t.timedOut) fails.push(`never settled: still "${panel.state}"${panel.loading ? " (load in flight)" : ""} after ${(t.settledMs / 1000).toFixed(1)}s — "${panel.text}"`);
  if (want.weather && want.weather !== "any") {
    if (want.weather === "error") {
      if (panel.state !== "error") fails.push(`expected a clear failure, got "${panel.state}" — "${panel.text}"`);
      else if (!panel.retry) fails.push("failure offers no retry");
    } else if (panel.state !== want.weather) {
      fails.push(`expected "${want.weather}", got "${panel.state}" — "${panel.text}"`);
    }
  }
  if (want.source && panel.source !== want.source && panel.state !== "error") fails.push(`expected the forecast from "${want.source}", got "${panel.source}"`);
  if (want.today && panel.days > 0) {
    // The page's clock runs `offset` ahead of ours (and keeps ticking), so "today" is
    // judged by the page's clock, in Melbourne.
    const expected = melbourneToday(new Date(Date.now() + t.offset));
    if (panel.today !== expected) fails.push(`"Today" is ${panel.today}, expected ${expected} (Melbourne)`);
  }
  if (want.firstPaintMs && (t.firstPaint == null || t.firstPaint > want.firstPaintMs)) {
    fails.push(`first forecast took ${t.firstPaint == null ? "forever" : `${(t.firstPaint / 1000).toFixed(1)}s`}, limit ${(want.firstPaintMs / 1000).toFixed(1)}s`);
  }
  if (want.settledMs && t.settledMs > want.settledMs) fails.push(`took ${(t.settledMs / 1000).toFixed(1)}s to settle, limit ${(want.settledMs / 1000).toFixed(1)}s`);
  if (!structure.header) fails.push("site header missing");
  if (want.table !== false && !structure.rows) fails.push("climbs table rendered no rows");
  if (want.map && !structure.map) fails.push("map did not render");
  if (!step.allowExceptions && s.exceptions.length) fails.push(`uncaught: ${[...new Set(s.exceptions)].slice(0, 3).join(" | ")}`);
  return fails;
}

async function runInteractions(profileRoot) {
  const id = "ix";
  const st = { snapshot: "fresh", live: "ok", offset: 0 };
  chainState.set(id, st);
  const mock = await startMock(st);
  const chrome = await Chrome.launch(fs.mkdtempSync(path.join(profileRoot, "ix-")),
    [`MAP ${WEATHER_HOST} 127.0.0.1:${mock.port}`, `MAP ${BACKUP_HOST} 127.0.0.1:${mock.port}`], ["--ignore-certificate-errors"]);
  const results = [];
  let s;
  try {
    s = await chrome.open();
    await s.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/s/${id}/${PAGE}` });
    await watch(s, 30000);
    for (const [name, script] of INTERACTIONS) {
      const before = s.exceptions.length;
      const out = await s.eval(script, true);
      const settled = await watch(s, 15000);
      const structure = JSON.parse((await s.eval(STRUCTURE_PROBE)).value || "{}");
      const fails = [];
      if (out.error) fails.push(`threw: ${out.error.split("\n")[0]}`);
      if (typeof out.value === "string" && out.value.startsWith("NOT RECOVERED")) fails.push(out.value);
      const raised = s.exceptions.slice(before);
      if (raised.length) fails.push(`uncaught: ${raised.slice(0, 2).join(" | ")}`);
      if (settled.timedOut) fails.push(`panel never settled — "${settled.panel?.text}"`);
      if (!structure.rows) fails.push("climbs table lost its rows");
      results.push({ name: `interaction: ${name}`, fails, note: out.value });
    }
    const final = await probe(s);
    results.push({ name: "interaction: page still healthy afterwards", fails: final?.state === "data" ? [] : [`ended "${final?.state}" — "${final?.text}"`] });
  } finally {
    s?.close();
    await chrome.kill();
    mock.server.close();
    chainState.delete(id);
  }
  return results;
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// --- Smoke test of a deployed copy: the page as served, with Open-Meteo's live API
// stalled (the real-world outage) and with everything third-party down.
async function runTarget(target, profileRoot) {
  const cases = [
    ["deployed page, network as it is", [], {}],
    ["deployed page, Open-Meteo's main API stalled (the outage)", [`MAP ${WEATHER_HOST} ${STALL}`], {}],
    ["deployed page, all of Open-Meteo stalled: the snapshot alone", [WEATHER_HOST, BACKUP_HOST].map((h) => `MAP ${h} ${STALL}`), { source: "snapshot" }],
    ["deployed page, every third party stalled", THIRD_PARTIES.map((h) => `MAP ${h} ${STALL}`), { source: "snapshot" }],
  ];
  const results = [];
  for (const [name, rules, extra] of cases) {
    const chrome = await Chrome.launch(fs.mkdtempSync(path.join(profileRoot, "t-")), rules, []);
    let s;
    try {
      s = await chrome.open();
      await s.send("Page.navigate", { url: target });
      const { panel, settledMs, firstPaint, timedOut } = await watch(s, 30000);
      const fails = check({ expect: { weather: "data", today: true, firstPaintMs: 4000, ...extra } }, panel,
        JSON.parse((await s.eval(STRUCTURE_PROBE)).value || "{}"), s, { settledMs, firstPaint, timedOut, offset: 0 });
      results.push({ name, fails, panel, settledMs, firstPaint });
    } finally {
      s?.close();
      await chrome.kill();
    }
  }
  return results;
}

function report(results) {
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    if (r.skipped) { skip++; console.log(`  SKIP  ${r.name} (${r.skipped})`); continue; }
    const timing = r.firstPaint != null ? ` [forecast at ${(r.firstPaint / 1000).toFixed(1)}s]` : r.settledMs != null ? ` [settled ${(r.settledMs / 1000).toFixed(1)}s]` : "";
    if (!r.fails.length) { pass++; console.log(`  PASS  ${r.name}${timing}${r.note ? ` → ${r.note}` : ""}`); }
    else { fail++; console.log(`  FAIL  ${r.name}${timing}`); for (const f of r.fails) console.log(`          ↳ ${f}`); }
  }
  console.log(`\n${pass}/${pass + fail} passed${skip ? `, ${skip} skipped` : ""}`);
  return fail;
}

async function main() {
  if (!fs.existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}`); process.exit(2); }
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--target");
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cragify-qa-"));
  await startStallServer();
  let failures;
  if (ti >= 0) {
    console.log(`Cragify QA — smoke-testing ${argv[ti + 1]}\n`);
    failures = report(await runTarget(argv[ti + 1], profileRoot));
  } else {
    const filter = argv.find((a) => !a.startsWith("--"));
    makeCert();
    await startFileServer();
    await fetchReal();
    console.log(`Cragify QA — ${REAL ? `real forecast fetched; main-API server answering: ${GOOD_IP || "none"}` : "real Open-Meteo unreachable: real-API steps skipped"}\n`);
    const selected = chains.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
    const jobs = Number(process.env.JOBS || 4);
    const all = (await pool(selected, jobs, (c, i) => runChain(c, i, profileRoot))).flat();
    if (!filter || "interactions".includes(filter.toLowerCase())) all.push(...(await runInteractions(profileRoot)));
    failures = report(all);
    fileServer.close();
  }
  stallServer.close();
  if (!process.env.KEEP) fs.rmSync(profileRoot, { recursive: true, force: true });
  else console.log(`Profiles kept in ${profileRoot}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
