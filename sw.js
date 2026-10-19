// Service worker for Cragify: caches the Open-Meteo weather response so a
// return visit with bad reception shows last-known weather instantly instead
// of stalling on a slow/failed network request, while a fresh copy is
// fetched in the background to update the cache for next time.
const CACHE_NAME = "cragify-weather-v1";
const WEATHER_HOST = "api.open-meteo.com";

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
  event.respondWith(staleWhileRevalidate(event.request));
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) return cached;
  const network = await networkFetch;
  if (network) return network;
  return new Response(null, { status: 504, statusText: "Weather unavailable offline" });
}
