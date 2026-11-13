// Service worker for Cragify: caches the Open-Meteo weather response so a
// visit with bad reception shows last-known weather instead of a blank panel.
//
// The cache is a fallback, not the primary source. The weather request URL
// never changes (the dates come from `past_days` / `forecast_days`, not the
// query string), so a cached body stays a valid cache hit forever while the
// forecast inside it silently goes out of date. So: anything older than
// MAX_FRESH_MS means the network is awaited first, and the stale copy is
// served only if that fails.
const CACHE_NAME = "cragify-weather-v2";
const WEATHER_HOST = "api.open-meteo.com";
const MAX_FRESH_MS = 15 * 60 * 1000;
// Written onto the cached response so its age can be judged without trusting
// the upstream `Date` header or the browser's HTTP cache.
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
  const url = new URL(event.request.url);
  if (url.hostname !== WEATHER_HOST) return;
  event.respondWith(weatherResponse(event, event.request));
});

// Stamp the time of caching onto the response, since a bare Response carries no
// record of when we stored it.
async function putStamped(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT, String(Date.now()));
  const body = await response.clone().arrayBuffer();
  await cache.put(request, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

function ageOf(response) {
  const stamp = Number(response.headers.get(CACHED_AT));
  return Number.isFinite(stamp) && stamp > 0 ? Date.now() - stamp : Infinity;
}

async function weatherResponse(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached && ageOf(cached) < MAX_FRESH_MS) return cached;

  // `cache: "no-store"` keeps the browser's own HTTP cache out of the loop, so
  // "go to the network" really means it — otherwise this can be answered by an
  // equally stale HTTP-cache entry for the same unchanging URL.
  let network = null;
  try {
    network = await fetch(new Request(request, { cache: "no-store" }));
  } catch (err) { /* offline — fall through to the cache below */ }

  if (network && network.ok) {
    event.waitUntil(putStamped(cache, request, network));
    return network;
  }
  // Network is down: an old forecast beats a blank panel, and the page labels
  // every day card with its own date, so an old one reads as old.
  if (cached) return cached;
  if (network) return network;
  return new Response(null, { status: 504, statusText: "Weather unavailable offline" });
}
