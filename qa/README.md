# Cragify QA

A live regression suite. It drives the real page in real Chrome and checks that the
weather loads — fast, and showing the right day — under every condition the app meets in
the field, and that the page can never end up blank, frozen, or stuck on a loading message.

```sh
node qa/qa.mjs                    # everything (~2–3 minutes, several browsers at once)
node qa/qa.mjs midnight           # only scenarios whose name contains "midnight"
node qa/qa.mjs --target https://vietcowboy.github.io/Outdoors/grampians-boulders.html
                                  # smoke-test the deployed site, incl. Open-Meteo stalled
JOBS=1 node qa/qa.mjs             # one browser at a time
KEEP=1 node qa/qa.mjs             # keep the browser profiles for inspection
```

The exit code is 0 only if everything passed, so it works as a pre-deploy gate. Needs
Google Chrome and Node 22+.

## Why it exists

The weather failed on its owner again and again, each time in a way that only showed up
in a browser on a real network — and more than once the real cause was somewhere other
than where the last fix had been. The one that finally explained it: Open-Meteo picks its
server by GeoDNS, and the one it gives Australia intermittently accepts connections and
never answers, while its European and US servers work fine from the same network. The
site now publishes a forecast snapshot with the page (see `scripts/fetch-forecast.mjs`),
and this suite proves the page loads the weather with Open-Meteo stalled.

## How conditions are produced

- **Network failures** are set at the Chrome process level with `--host-resolver-rules`,
  not CDP interception: CDP's `Fetch`/`Network` domains don't see a service worker's own
  requests, which is exactly the path that matters. A host can be *unreachable*, or can
  *stall* — mapped to a local socket that accepts the connection and then says nothing,
  forever. Stalling is the nastier case, and the real one: nothing fails fast.
- **Open-Meteo is impersonated** by a local HTTPS server per scenario (self-signed, so the
  browser runs with `--ignore-certificate-errors`), returning a structurally faithful
  forecast generated around "today" — or garbage, truncated JSON, a captive-portal page, a
  500, a 429, and so on. That makes the suite deterministic. Two scenarios use the real API,
  routed to a server known to answer; they're skipped if Open-Meteo is unreachable.
- **The snapshot** (`data/forecast.json`) is generated per scenario: fresh, hours old, from
  yesterday, expired, for a different request, garbage, missing, or stalled.
- **The clock** can be moved (a shim replaces `Date` in the page), and **the device's
  timezone** changed (`Emulation.setTimezoneOverride`) — which is how midnight, new year,
  daylight saving and holidays are tested without waiting for them.
- **Old service workers** are installed by serving the page and worker from an earlier git
  revision, then upgrading — every worker the site has shipped.
- **Each scenario chain is served under its own path** (`/s/<id>/`), so it gets its own
  service worker scope, and chains run in parallel without sharing state. A chain's steps
  share one browser profile, which is how "warm cache" steps are warmed by a genuine
  earlier visit rather than seeded by hand.

## What it asserts

Every step: the panel settles (no loading message left on screen, no load in flight),
the climbs table rendered, and nothing threw. Then per scenario: whether the panel should
show a current forecast, a forecast labelled with its age, or a clear failure with a
retry; which source it should have come from; that **"Today" is today's date in
Melbourne**; and, where it matters, how quickly the first forecast appeared.

## Gotchas worth preserving

Harness bugs have produced convincing false failures before. Don't reintroduce them:

1. **Fixed ports.** One debugging port for every scenario let a new Chrome attach to the
   previous, still-dying instance — still carrying the previous scenario's network rules.
   Every port is now assigned by the OS (`--remote-debugging-port=0`, servers on port 0).
2. **SIGKILL on teardown.** CacheStorage is flushed asynchronously; killing Chrome outright
   loses it, silently turning every warm-cache step cold. Teardown is SIGTERM and a wait.
3. **Judging liveness by word count.** Most of the page's text is the forecast, so a
   weather failure leaves little text on a perfectly healthy page. Liveness is structural.
4. **Trusting "it settled".** The panel can show a forecast while a slower request is still
   in flight — and a late failure must not replace it. Steps wait until no load is in
   flight before judging.
