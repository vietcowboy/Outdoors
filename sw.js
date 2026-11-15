// Service worker for Cragify: caches the Open-Meteo weather response so the
// forecast still appears in a Grampians car park with one bar of reception.
//
// The design that matters here: the cached copy is painted *immediately*, and
// the page then asks for a fresh one and swaps it in. The worker never decides
// on its own that stale data is good enough, and it never makes the page wait
// on the network before showing something it already has.
//
// Two rules keep that honest:
//   - A copy older than MAX_USEFUL_MS is not painted at all. The weather
//     request URL never changes (the dates come from past_days/forecast_days,
//     not the query string), so an old body stays a valid cache hit forever
//     while the forecast inside it goes stale. Past a day old it is too
//     misleading to show even briefly.
//   - A request that explicitly asks to skip the cache (cache: "reload", which
//     is how the page asks for its refresh) always goes to the network.
//
// Responses are stamped with the time they were cached, both to judge that age
// and to let the page label what it is showing as not-current.
const CACHE_NAME = "cragify-weather-v3";
const WEATHER_HOST = "api.open-meteo.com";
const MAX_USEFUL_MS = 24 * 60 * 60 * 1000;
const CACHED_AT = "x-cragify-cached-at";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch (err) {
    return;
  }
  if (url.hostname !== WEATHER_HOST) return;
  event.respondWith(weatherResponse(event));
});

// A bare Response carries no record of when it was stored, so write it on.
async function putStamped(cache, key, response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT, String(Date.now()));
  const body = await response.clone().arrayBuffer();
  await cache.put(key, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

function ageOf(response) {
  const stamp = Number(response.headers.get(CACHED_AT));
  return Number.isFinite(stamp) && stamp > 0 ? Date.now() - stamp : Infinity;
}

async function weatherResponse(event) {
  const request = event.request;
  // Cache keys are the URL string throughout. Passing Request objects in here
  // drags their cache mode and headers into matching, which is exactly the kind
  // of subtlety that silently turns a hit into a miss.
  const key = request.url;
  try {
    const cache = await caches.open(CACHE_NAME);
    const wantsFresh = request.cache === "reload" || request.cache === "no-store";

    if (!wantsFresh) {
      const cached = await cache.match(key);
      if (cached && ageOf(cached) < MAX_USEFUL_MS) return cached;
    }

    // Built from the URL rather than cloned from `request`: a plain
    // cross-origin GET with no custom headers, so there is nothing worth
    // copying and plenty that can go wrong copying it. "no-store" keeps the
    // browser's own HTTP cache out of the loop, so going to the network really
    // means it, rather than being answered by an equally old HTTP-cache entry
    // for the same unchanging URL.
    let network = null;
    try {
      network = await fetch(key, { cache: "no-store", mode: "cors", credentials: "omit" });
    } catch (err) { /* offline, or the request was blocked — fall through */ }

    if (network && network.ok) {
      event.waitUntil(putStamped(cache, key, network.clone()));
      return network;
    }

    // Network is unhappy. Anything cached now beats an empty panel, however
    // old: the page labels what it paints with the age below.
    const cached = await cache.match(key);
    if (cached) return cached;
    if (network) return network;
    return new Response(null, { status: 504, statusText: "Weather unavailable offline" });
  } catch (err) {
    // The worker must never be the reason the forecast fails. If anything above
    // broke — storage unavailable in private browsing, a quota error, a bug in
    // here — get out of the way and let the page's own request through.
    return fetch(request);
  }
}
