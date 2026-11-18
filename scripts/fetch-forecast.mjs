#!/usr/bin/env node
// Fetch the Open-Meteo forecast Cragify shows, and write it as the snapshot the site
// publishes next to the page (data/forecast.json).
//
// Why this exists: Open-Meteo picks a server by GeoDNS, and the one it hands Australia
// has repeatedly accepted connections and then never answered — while its European and
// US servers, reached from the same Australian network, answered in about a second. A
// visitor's browser can't choose a different server. This can: it runs in GitHub Actions
// (US), normally gets a working server by plain DNS; failing that tries Open-Meteo's
// previous-runs API (the same forecast from a different server); and failing that asks DNS
// which servers Open-Meteo gives other regions and connects to those directly.
//
// The request is not written down here. It is built by evaluating the <wx-config> region
// of the page itself, so the snapshot is always of exactly the request the page makes,
// and the page refuses a snapshot whose URL isn't its own.
//
//   node scripts/fetch-forecast.mjs --html grampians-boulders.html --out data/forecast.json \
//        [--carry-forward https://vietcowboy.github.io/Outdoors/data/forecast.json] [--strict]
//
// It never fails the deploy over the forecast (unless --strict): if nothing can be
// fetched it republishes the last good snapshot (--carry-forward), whose age the page
// shows, or writes nothing and the page falls back to Open-Meteo directly.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { promises as dns } from "node:dns";
import vm from "node:vm";

const TZ = "Australia/Melbourne";
const BACKUP_HOST = "previous-runs-api.open-meteo.com";
const REQUEST_TIMEOUT_MS = 15000;
const UA = "cragify-forecast-snapshot (+https://github.com/vietcowboy/Outdoors)";
// Client subnets to ask DNS on behalf of, to learn which servers Open-Meteo hands to
// other regions. Europe and North America have been reliable; Australia hasn't.
const ECS_SUBNETS = ["85.214.0.0/16", "8.8.8.0/24", "203.2.218.0/24"];

const inActions = !!process.env.GITHUB_ACTIONS;
const log = (msg) => console.log(msg);
const warn = (msg) => console.log(inActions ? `::warning::${msg}` : `warning: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

// Evaluate the page's <wx-config> region and ask it for its request.
export function requestFromPage(html) {
  const start = html.indexOf("// <wx-config>");
  const end = html.indexOf("// </wx-config>");
  if (start < 0 || end < 0 || end < start) throw new Error("no <wx-config> region in the page");
  const code = html.slice(html.indexOf("\n", start) + 1, end);
  const result = vm.runInNewContext(`${code}\n;({ url: wxForecastUrl(), spots: WX_SPOTS.length })`,
    { URLSearchParams }, { timeout: 1000 });
  if (typeof result.url !== "string" || !result.url.startsWith("https://api.open-meteo.com/")) {
    throw new Error(`unexpected forecast URL from the page: ${result.url}`);
  }
  return { url: result.url, spots: result.spots };
}

export function melbourneToday(now = new Date()) {
  const part = {};
  for (const p of new Intl.DateTimeFormat("en-AU", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)) part[p.type] = p.value;
  return `${part.year}-${part.month}-${part.day}`;
}

// The checks that matter for the page: one entry per spot, each with dated daily rows
// and hourly rows, and — for a fresh fetch — today among the days.
export function checkPayload(payload, spots, { today } = {}) {
  if (!Array.isArray(payload)) return "response is not a list of locations";
  if (payload.length !== spots) return `expected ${spots} locations, got ${payload.length}`;
  for (const [i, loc] of payload.entries()) {
    const days = loc && loc.daily && loc.daily.time;
    if (!Array.isArray(days) || days.length < 7) return `location ${i} has ${Array.isArray(days) ? days.length : "no"} days`;
    if (!days.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) return `location ${i} has malformed dates`;
    if (!loc.hourly || !Array.isArray(loc.hourly.time) || !loc.hourly.time.length) return `location ${i} has no hourly data`;
    if (today && !days.includes(today)) return `location ${i} doesn't include today (${today})`;
  }
  return null;
}

async function viaDns(url) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Connect to one specific server IP, keeping the real hostname for TLS (SNI and the
// certificate check) and for the Host header — exactly as if DNS had returned this IP.
export function viaIp(url, ip) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname,
      servername: u.hostname,
      path: u.pathname + u.search,
      headers: { "user-agent": UA, accept: "application/json" },
      lookup: (hostname, options, cb) => (options && options.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error("unreadable JSON")); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

// Which IPs does DNS hand out for this host, as seen from several regions?
export async function serversElsewhere(host) {
  const ips = new Set();
  const queries = [
    ...ECS_SUBNETS.map((s) => `https://dns.google/resolve?name=${host}&type=A&edns_client_subnet=${encodeURIComponent(s)}`),
    `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
  ];
  await Promise.all(queries.map(async (q) => {
    try {
      const res = await fetch(q, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      for (const a of json.Answer || []) if (a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)) ips.add(a.data);
    } catch (err) { /* one resolver down is fine */ }
  }));
  return [...ips];
}

async function fetchFresh(url, spots) {
  const today = melbourneToday();
  const attempt = async (label, run) => {
    try {
      const payload = await run();
      const problem = checkPayload(payload, spots, { today });
      if (problem) { log(`  ${label}: unusable (${problem})`); return null; }
      log(`  ${label}: ok`);
      return payload;
    } catch (err) {
      log(`  ${label}: ${err.message}`);
      return null;
    }
  };
  const host = new URL(url).hostname;
  // Open-Meteo's previous-runs API serves the identical request — same models, same
  // numbers — from a different server. The page uses it as its live backup too.
  const backup = new URL(url);
  backup.host = BACKUP_HOST;
  // Two rounds: plain DNS, then the backup host, then every other server DNS hands out
  // elsewhere for the main API — with the ones our own DNS returned (the likeliest to be
  // the broken one) tried last.
  for (const round of [1, 2]) {
    if (round === 2) await sleep(5000);
    const direct = await attempt(`round ${round}: direct`, () => viaDns(url));
    if (direct) return { payload: direct, via: "dns" };
    const fallback = await attempt(`round ${round}: ${BACKUP_HOST}`, () => viaDns(backup.href));
    if (fallback) return { payload: fallback, via: BACKUP_HOST };
    const local = new Set(await dns.resolve4(host).catch(() => []));
    const ips = (await serversElsewhere(host)).sort((a, b) => local.has(a) - local.has(b));
    log(`  round ${round}: other servers for ${host}: ${ips.join(", ") || "none found"}`);
    for (const ip of ips) {
      const payload = await attempt(`round ${round}: via ${ip}`, () => viaIp(url, ip));
      if (payload) return { payload, via: `ip:${ip}` };
    }
  }
  return null;
}

async function carryForward(from, url, spots) {
  try {
    const res = await fetch(from, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const snap = await res.json();
    if (!snap || snap.v !== 1 || snap.url !== url) return null;
    if (checkPayload(snap.payload, spots)) return null;
    return snap;
  } catch (err) {
    return null;
  }
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (!opt.html || !opt.out) {
    console.error("usage: fetch-forecast.mjs --html <page> --out <snapshot.json> [--carry-forward <url>] [--strict]");
    process.exit(2);
  }
  const { url, spots } = requestFromPage(fs.readFileSync(opt.html, "utf8"));
  log(`Forecast request (${spots} spots): ${url}`);

  const fresh = await fetchFresh(url, spots);
  let snapshot = null;
  if (fresh) {
    snapshot = { v: 1, fetchedAt: new Date().toISOString(), url, source: "open-meteo", via: fresh.via, payload: fresh.payload };
    log(`Fetched a fresh forecast (${fresh.via}).`);
  } else if (typeof opt["carry-forward"] === "string") {
    snapshot = await carryForward(opt["carry-forward"], url, spots);
    if (snapshot) warn(`Open-Meteo unreachable from every server tried; republishing the snapshot from ${snapshot.fetchedAt}.`);
  }

  if (!snapshot) {
    warn("No forecast snapshot this deploy: Open-Meteo was unreachable and there was nothing to carry forward. The page falls back to Open-Meteo directly.");
    process.exit(opt.strict ? 1 : 0);
  }
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, JSON.stringify(snapshot));
  log(`Wrote ${opt.out} (${fs.statSync(opt.out).size} bytes, fetched ${snapshot.fetchedAt}).`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("fetch-forecast.mjs")) {
  main().catch((err) => {
    // A bug in this script must not take the site down with it either.
    warn(`fetch-forecast failed: ${err.stack || err.message}`);
    process.exit(args(process.argv.slice(2)).strict ? 1 : 0);
  });
}
