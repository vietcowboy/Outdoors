// Service worker for Cragify.
//
// Two jobs, both about having something to show with no reception:
//   - Keep the last forecast that got through — from every source the page uses: the
//     snapshot published with the site (data/forecast.json) and Open-Meteo itself, on
//     either of the hosts the page asks (its main API and its previous-runs API).
//   - Keep the page itself, so it still opens at all in a car park at the crag, e.g.
//     when the phone has evicted the tab and reloads it with no signal.
//
// Everything is network-first, with a time limit, then the saved copy. Nothing is served
// from the cache while the network is answering, so a working connection always gets
// the current page and the current forecast. Saved forecasts carry the time they were
// saved (CACHED_AT), which is how the page knows to say one is old.
//
// The page never relies on this worker existing: with it absent, blocked (private
// browsing) or broken, every request simply goes to the network as normal.

const WEATHER_CACHE = "cragify-weather-v3";
const SHELL_CACHE = "cragify-shell-v1";
// Only our own caches are ever deleted. CacheStorage belongs to the whole origin — every
// GitHub Pages project under vietcowboy.github.io shares it — so "delete everything that
// isn't the current cache" would delete other sites' caches too.
const OWN_PREFIX = "cragify-";
const KEEP = new Set([WEATHER_CACHE, SHELL_CACHE]);

// The Open-Meteo hosts the page asks for the forecast (see WX_LIVE_HOSTS in the page).
const WEATHER_HOSTS = new Set(["api.open-meteo.com", "previous-runs-api.open-meteo.com"]);
const CACHED_AT = "x-cragify-cached-at";
// Under the page's own 8s limit, so a stalled request still gets the saved copy to the
// page before the page stops waiting.
const WEATHER_TIMEOUT_MS = 6000;
// How long a navigation waits on the network before opening the saved page instead. The
// network response still lands in the cache when it arrives, for next time.
const SHELL_TIMEOUT_MS = 6000;
// A warm request for something saved more recently than this is skipped.
const WARM_SKIP_MS = 10 * 60 * 1000;

const inScope = (path) => new URL(path, self.registration.scope).href;
const SNAPSHOT_URL = inScope("data/forecast.json");
const SHELL_URLS = [
  inScope("grampians-boulders.html"),
  inScope("vendor/leaflet/leaflet.js"),
  inScope("vendor/leaflet/leaflet.css"),
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Best effort. A failed precache must not fail the install, or one flaky first visit
  // would leave the site with no worker at all.
  event.waitUntil(precache().catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith(OWN_PREFIX) && !KEEP.has(k))
        .map((k) => caches.delete(k))))
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  const bare = url.origin + url.pathname;
  if (WEATHER_HOSTS.has(url.hostname)) {
    event.respondWith(guard(weatherResponse(event, req.url), req));
  } else if (bare === SNAPSHOT_URL) {
    event.respondWith(guard(weatherResponse(event, SNAPSHOT_URL), req));
  } else if (url.origin === self.location.origin && SHELL_URLS.includes(bare)) {
    event.respondWith(guard(shellResponse(event, req, bare), req));
  }
  // Anything else isn't ours to handle: the browser does what it always does.
});

// Warm the forecast cache on request from the page. On a first visit the page's own
// requests happen before this worker controls it, so they never pass through here and
// nothing is saved — leaving the cache empty exactly when it's needed (loaded at home on
// wifi, then driven out of reception). A fetch started from inside the worker always
// lands in its cache. Older pages send `url`; current ones send `urls`.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "warm-weather") return;
  const urls = Array.isArray(data.urls) ? data.urls : typeof data.url === "string" ? [data.url] : [];
  event.waitUntil(Promise.all(urls.filter(isWeatherUrl).map(warm)).catch(() => {}));
});

function isWeatherUrl(href) {
  try {
    const url = new URL(href);
    return WEATHER_HOSTS.has(url.hostname) || url.origin + url.pathname === SNAPSHOT_URL;
  } catch (err) {
    return false;
  }
}

async function warm(href) {
  const key = WEATHER_HOSTS.has(new URL(href).hostname) ? href : SNAPSHOT_URL;
  const cache = await caches.open(WEATHER_CACHE);
  const saved = await cache.match(key);
  if (saved && ageOf(saved) < WARM_SKIP_MS) return;
  const fresh = await fetchForecast(key);
  if (fresh) await saveForecast(cache, key, fresh);
}

// The worker must never be the reason a request fails. If anything in it breaks —
// storage unavailable, a quota error, a bug — get out of the way and let the request go
// to the network as if the worker weren't here.
async function guard(promise, req) {
  try {
    return await promise;
  } catch (err) {
    return fetch(req);
  }
}

// AbortSignal.timeout is Safari 16+. Calling it on anything older would throw inside the
// fetch, be taken for "offline", and leave this worker serving nothing but saved copies.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ageOf(response) {
  const stamp = Number(response.headers.get(CACHED_AT));
  return Number.isFinite(stamp) && stamp > 0 ? Date.now() - stamp : Infinity;
}

// ---------------------------------------------------------------- forecasts

// Does this body look like a forecast — Open-Meteo's response, or the snapshot wrapping
// one? Anything else (a captive portal's login page, an error, a truncated download) is
// treated as a failed request: never saved, and never handed to the page in place of the
// saved copy.
function isForecast(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return false;
  }
  const located = (loc) => !!(loc && loc.daily && Array.isArray(loc.daily.time) && loc.daily.time.length);
  const all = (list) => Array.isArray(list) && list.length > 0 && list.every(located);
  if (Array.isArray(json)) return all(json);
  if (json && json.v === 1) return all(json.payload);
  return located(json);
}

// Fetch a forecast from the network, bounded end to end — the time limit covers the body
// as well as the headers, so a response that starts and then stalls is caught too.
// Resolves to the body text if it is a forecast, otherwise null.
async function fetchForecast(key) {
  try {
    const res = await fetch(key, {
      cache: "no-store",
      credentials: "omit",
      signal: timeoutSignal(WEATHER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return isForecast(text) ? text : null;
  } catch (err) {
    return null;
  }
}

async function saveForecast(cache, key, text) {
  await cache.put(key, new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", [CACHED_AT]: String(Date.now()) },
  }));
}

async function weatherResponse(event, key) {
  let cache = null;
  try {
    cache = await caches.open(WEATHER_CACHE);
  } catch (err) { /* no storage: network only */ }

  const fresh = await fetchForecast(key);
  if (fresh) {
    if (cache) event.waitUntil(saveForecast(cache, key, fresh).catch(() => {}));
    return new Response(fresh, { status: 200, headers: { "content-type": "application/json" } });
  }

  // The network failed, stalled, or answered with something that isn't a forecast. The
  // last one that got through beats an empty panel: it carries its age, and the page
  // decides whether it still covers today.
  const saved = cache ? await cache.match(key).catch(() => null) : null;
  if (saved) return saved;
  return new Response(null, { status: 504, statusText: "Weather unavailable offline" });
}

// ---------------------------------------------------------------- the page itself

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(SHELL_URLS.map(async (url) => {
    try {
      const res = await fetch(url, { cache: "no-store", signal: timeoutSignal(SHELL_TIMEOUT_MS) });
      if (res.ok && !res.redirected) await cache.put(url, res);
    } catch (err) { /* next visit will try again */ }
  }));
}

async function shellResponse(event, req, key) {
  let cache = null;
  try {
    cache = await caches.open(SHELL_CACHE);
  } catch (err) { /* no storage: network only */ }

  // `fetch(req)` as-is: a navigation request can't be re-built with a signal, so the
  // time limit is a race instead, and the network carries on in the background.
  const network = fetch(req).then((res) => {
    // A redirected response can't be replayed for a later navigation, so isn't saved.
    if (cache && res.ok && !res.redirected) {
      const copy = res.clone();
      event.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return res;
  });
  event.waitUntil(network.catch(() => {}));

  const first = await Promise.race([
    network.then((res) => res, () => "failed"),
    sleep(SHELL_TIMEOUT_MS).then(() => "slow"),
  ]);
  // The network answered properly, in time: that's the current page.
  if (first instanceof Response && first.status < 500) return first;

  const saved = cache ? await cache.match(key).catch(() => null) : null;
  if (saved) return saved;
  // Nothing saved. Hand back whatever the network gives, however long it takes.
  if (first instanceof Response) return first;
  if (first === "slow") return network;
  return Response.error();
}
