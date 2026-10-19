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
  event.respondWith(staleWhileRevalidate(event, event.request));
});

async function notifyClients() {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((c) => c.postMessage({ type: "weather-updated" }));
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
        // Only the pages care if this was an actual refresh of data they'd
        // already shown — not the very first fetch that had nothing to update.
        if (cached) await notifyClients();
      }
      return response;
    })
    .catch(() => null);
  // Keep the service worker alive for the background refresh even though we
  // respond with the cached copy (if any) right away below.
  event.waitUntil(networkFetch);
  if (cached) return cached;
  const network = await networkFetch;
  if (network) return network;
  return new Response(null, { status: 504, statusText: "Weather unavailable offline" });
}
