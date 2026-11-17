# Cragify QA

Live regression suite. It drives the real page in real Chrome and asserts that it cannot
end up blank, frozen, or stuck on a loading message.

```sh
node qa/qa.mjs            # every scenario
node qa/qa.mjs weather    # scenarios matching "weather"
KEEP=1 node qa/qa.mjs     # keep browser profiles for inspection
```

Exit code is 0 only if everything passed, so it works as a pre-deploy gate.

## Why it exists

The weather panel broke three times in a week, each time in a way that only appeared in a
browser on a bad network — and twice the real cause was somewhere else entirely. Static
review and unit-style harnesses missed all three. This runs the actual page under the
actual failure conditions instead.

## How failure conditions are produced

Network conditions are set at the Chrome process level with `--host-resolver-rules`, not
via CDP interception, because **CDP's `Fetch`/`Network` domains do not intercept a service
worker's own requests** — the exact path that matters here. Two kinds:

- **unreachable** — mapped to an unroutable address, so connections fail.
- **stalls** — mapped to a local socket that completes the TCP handshake and then says
  nothing, forever. This is the nastier case and the one that actually hung the page:
  nothing fails fast, because the connection looks alive.

## What it asserts

The inviolable rule: the page must never be left looking like it is still working.
Beyond that, each scenario declares what the weather panel should reach — live `data`,
the cached forecast with a staleness banner (`stale`), or a clear `error` with a retry —
and every scenario checks the page survived: header present, climbs table rendered (it
needs no network at all), no uncaught exceptions.

## Gotchas worth preserving

Three harness bugs produced false failures and cost real time. Don't reintroduce them:

1. **One CDP port for every scenario.** A new Chrome cannot bind a port the previous
   instance still holds, so the readiness probe connects to the *old* instance — still
   carrying the previous scenario's network rules. Scenarios then run under the wrong
   conditions and the suite flaps. Each launch now gets its own port.
2. **SIGKILL on teardown.** CacheStorage is flushed asynchronously; killing Chrome
   outright loses it, silently turning every warm-cache scenario cold. Teardown is
   SIGTERM with a wait.
3. **Judging liveness by word count.** Most of the page's visible text *is* the forecast,
   so a weather failure legitimately leaves little text while the page is perfectly fine.
   Liveness is structural: header present and table rows rendered.

Also: Open-Meteo itself went down three times during one day of this work. The suite
preflights it per scenario and marks data-dependent scenarios SKIP rather than FAIL when
it is unreachable — otherwise an upstream outage reads as a wall of app bugs.

## Coverage

40 checks, in four groups:

- **Network conditions** — baseline cold/warm; the weather host unreachable and stalled,
  each with a cold and a warm cache; the Leaflet CDN unreachable and stalled; fonts and
  map tiles gone; every third party down at once; fully offline after a good visit.
- **Hostile API responses** — a local HTTPS server impersonates Open-Meteo (self-signed,
  so these scenarios run with `--ignore-certificate-errors`) and returns garbage,
  truncated JSON, an empty body, an empty or absent `daily` object, null values, a
  forecast dated in the past, a 500, and a 429.
- **Crippled platforms** — no CacheStorage, no service worker, `caches.open` rejecting,
  `localStorage` throwing on every access, and no `AbortSignal.timeout` (Safari 15),
  including that last one combined with an unreachable host. None may throw at startup:
  the app is one script block, so a top-level throw takes the forecast down with it.
- **Interaction stress** — the retry button mashed, tabs and spots toggled, the panel
  scroll-loaded, the grade slider swept, every modal cycled, every header sorted, every
  marker clicked, and a simulated date rollover — then a final check that the page and
  forecast are still healthy.
