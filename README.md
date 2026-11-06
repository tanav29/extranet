# Extranet

Share folders and apps from your computer with the people around you — over
your Wi-Fi, or with anyone anywhere through a Cloudflare link.

Guests get a dead-simple page: browse folders, view photos / PDFs / video / text
right in the browser, download anything (or a whole folder as a single
`.zip`), and open an app that runs on this computer under a short address.

```
npx .          # from this repo
npx extranet   # once the package is published to the npm registry
```

Then open **http://localhost:8787/admin** on the same computer.

## How it runs — four services behind one proxy

One small reverse proxy is the only public listener. It routes every URL path
to four separate processes it supervises:

```
 bin/cli.js ──► server/index.js  (supervisor)
                 ├─► proxy   0.0.0.0:8787   the public edge — routes every path
                 ├─► web    127.0.0.1:3000  app/dist UI: / /admin /analytics /app/*
                 ├─► api    127.0.0.1:5000  /api/* registry, settings, tunnel, analytics
                 └─► files  127.0.0.1:8080  /files/* folder shares, viewer, ZIPs
```

- **The proxy is the only way in.** `web`, `api` and `files` bind `127.0.0.1`
  only; the proxy listens on `0.0.0.0` and is the process the tunnel dials.
  It is plain Node `http` (not Fastify) for speed and control.
- **The services share no memory.** Cross-process state lives in `data/`:
  the route registry in `config.json`, the actually-bound ports in
  `runtime.json` (written only by the supervisor from child readiness messages), and the access log in
  `logs.json` (owned by the proxy).
- **The supervisor** (`server/index.js`) spawns the four, relays their output
  with a `[name]` prefix, persists config before starting children, prints one banner once every current
  child has reported its port, restarts crashed children (up to 10 attempts, 800 ms apart), and
  tears everything down on Ctrl+C. Launched through `bin/cli.js`, so `npx`,
  `npm start` and a symlinked global install all behave the same.
- **The proxy tags every request** with `x-client-kind: local | lan | tunnel`,
  and the pages and services use it to decide what a guest from where is
  allowed to see.

### Path routing

| Path | Served by |
|------|-----------|
| `/` | web — the guest start page (its data comes from `/api/directory`) |
| `/admin`, `/analytics` | web — console and analytics (403 on the tunnel) |
| `/app/*` | web — the Vite bundle's assets |
| `/api/*` | api — route registry, settings, tunnel control, blocklist, logs |
| `/files/<name>/…` | files — folder share `<name>` |
| `/<name>` — any other path | proxy — an app-port share pointing at a local port |
| `/__ctl/*` | proxy-internal control (localhost + admin token only) |

Dynamic route addresses may never claim the service prefixes: `/admin`,
`/api`, `/files`, `/analytics`, `/app`, `/favicon.ico`, `/robots.txt`,
`/__ctl`. Anything the registry doesn't resolve falls through to web's
"Nothing here" page.

## Project layout

```
bin/cli.js           the launcher — the only thing you run (npx / npm start)
server/index.js      the supervisor: spawns, restarts and tears down the four
server/proxy.js      the reverse proxy: route registry, rebind, logs, blocks
server/web.js        the UI service (app/dist)
server/api.js        the API service (/api/*)
server/files.js      the folder-share service (/files/*)
server/lib.js        shared code: config/runtime/log files, PIN gates
app/                 the Vite + React + Tailwind source (admin, guest, analytics)
app/dist/            the compiled UI the web service serves (gitignored)
data/                runtime data: config.json, runtime.json, logs.json
```

Backend = four plain Node processes in `server/` (three Fastify apps + one
`http` proxy). Frontend = one Vite app in `app/`, built into `app/dist/` —
no server-side templating. Fonts load from Google Fonts at runtime, so no
font files live in the repo. Runtime data lives in `data/` next to the repo;
for an installed copy it moves to `~/.extranet/data`.

Useful flags: `npx . --port 6060` (overrides the proxy port for one run),
`npx . --build` (rebuild the UI), `npx . --help`.

## What you get

- **Start page (`/`)** — a public directory for guests: a "Hi 👋" hero with the
  computer's name, live status chips (battery level pulled natively from the
  OS — PowerShell `PowerStatus` on Windows, `pmset` on macOS, `/sys` on Linux —
  re-checked every minute; primary network connection; whether the host itself
  has internet), and a card for every share this visitor is allowed to see —
  folders and app ports, with PIN and scope badges. The share list is
  filtered per visitor: the owner sees everything, Wi-Fi guests see Wi-Fi
  shares, internet-link guests see public shares only (and never the host's
  LAN address). `/?json=1` (or an `Accept: application/json` request to `/`)
  returns the same data as JSON. The admin console stays at `/admin`.
- **Desktop-style UI** — a fixed sidebar + canvas app frame: the console puts
  the share list front and center with network and internet-link panels in a
  side rail; analytics is a two-pane view (request log ⇄ clients & blocking);
  the guest page is a proper file manager with list/grid views, search, and a
  status bar. All panes scroll inside the frame, with a light/dark toggle.
- **Real shadcn/ui** — the admin console, the guest page, and analytics are
  built with actual shadcn/ui components (React + Tailwind + Radix) in `app/`,
  compiled into `app/dist/` and served statically. Bump the design by
  editing `app/src` and rebuilding.
- **Folder shares** — map any folder to a short web address, e.g.
  `D:\Movies` → `/files/movies`. Guests open `http://<your-ip>:8787/files/movies/`.
  (The address you pick is the share *name*; folder shares always live under
  `/files/`. Guest links are plain `http://` — the old self-signed HTTPS mode
  was removed on purpose.) Each share can be visible on the Wi-Fi, through
  the internet link, or both.
- **App-port shares** — expose anything already running on this computer under
  the same style of address but without a prefix: `/webapp` → `127.0.0.1:3000`.
  Every request under the address is forwarded to that local port.
  Apps usually expect to own a whole site: they write root-absolute paths
  (`/static/app.css`), absolute form actions, and `Location: /login` — fine at
  an origin of their own, broken under a path. The share repairs that on its
  own, without subdomains or an app-side base-path setting: opening
  `/webapp` redirects to `/webapp/`, complete (uncompressed, reasonably small)
  HTML and CSS responses are rewritten in place so root-absolute references
  resolve under the share. Root-scoped app cookies are namespaced per share so
  they work on root-level API paths without collisions; `Location:` headers
  are repointed. Runtime URLs such as `fetch('/api/...')` use the same-origin
  Referer to select the app that served the page. This supports multiple app
  shares on one hostname without subdomains. A session cookie keeps root-level SPA routes
  such as `/pair` associated with the selected app after navigation. Requests
  without a matching referrer or app session fall back only when one app
  share is visible; ambiguous requests stay unclaimed. Streamed,
  compressed or oversized responses pass through untouched; inline script
  bodies keep their exact bytes. WebSockets are rejected with a clear 501 page;
  regular HTTP only. A T3 Code share on port 3773 redirects its root to `/pair`.
- **One-time PIN lock (6 digits)** — any share can require a 6-digit PIN.
  The first PIN-less visit gets a small lock page (401); a wrong PIN gets
  403 and throttling; the right PIN answers 303 with a `Set-Cookie:
  xpin-<route>=…` cookie (a SHA-256 of the PIN, never the PIN itself) so the
  browser remembers it for 6 months. Links that carry it
  (`/files/movies/?pin=123456`) unlock on the spot. Copies and QR codes from
  the admin page include the PIN automatically, and the PIN never shows up
  in the access log. The owner's own computer (localhost) skips the gate —
  and its throttle — entirely.
- **Folders you shared are remembered** — after you unshare (or restart), the
  folder stays in the "Recent" chips of the add form and the folder picker, so
  re-sharing is one click, not a re-browse.
- **Your addresses** — the console lists every LAN IP of this computer, and
  every share has a **QR** button (also for the public link while it's running).
  The QR dialog is deliberately small so it never overflows on phones.
- **Analytics** — an `/analytics` page (same admin protection) with:
  - every guest request to shares: time, IP, method, path, status, bytes,
    share name, blocked flag,
  - aggregated **clients**: how much each IP took, device guess, last seen,
  - **blocking**: one click blocks an address — blocked IPs get a 403 on all
    guest traffic at the proxy (localhost can't be blocked). Unblock anytime.
    Logs keep the last 3000 requests + 600 clients and survive restarts
    (`data/logs.json`); the web UI can auto-refresh 5s live, and the log can
    be cleared in place without losing the analytics page.
- **Internet link** — one click runs `cloudflared` as a *quick tunnel* pointed
  at the proxy port and gives a random `https://something.trycloudflare.com`
  address you can send to anyone. Tunnel URLs are path-based
  (`…/files/movies/`, `/webapp`) — no subdomains, so everything a guest can
  reach over Wi-Fi works identically through the link, except `/admin` and
  `/analytics`, which answer 403 "Not available on the public link". You
  don't need a Cloudflare account, and nothing is permanently exposed: the
  link is live only while the tunnel runs, and each run gets a fresh address.
  If cloudflared isn't installed, the app downloads it for you (Windows) or
  tells you what to install (`brew install cloudflared` / `apt install cloudflared`).
- **Receiver page** — minimal list with previews (image, video, audio, PDF,
  text/code), per-file downloads, prev/next between files, a search box, and
  "Download all (.zip)" for the current folder.

## Ports

Defaults: proxy **8787** (public) + internal web **3000**, api **5000**,
files **8080**. A service whose preferred port is taken bumps to the next
free one and reports its actual port to the supervisor over IPC. The supervisor alone
updates `data/runtime.json`, with a run ID and the PID of each ready service.

- **Live port change** — the proxy rebinds itself when the saved `proxyPort`
  changes (the console or `PATCH /api/settings {"proxyPort": n}` rewrites
  `config.json`; the proxy watches the file). If the wanted port is taken it
  sticks; if the rebind fails it rolls back to the previous port. Route
  changes, PINs and blocks apply live without any restart.
- **Locked port** — starting with `--port <n>` / `EXTRANET_PORT` pins the
  proxy port for that run: never persisted, and live port changes are
  ignored while it's set.
- Per-service env overrides: `EXTRANET_WEB_PORT`, `EXTRANET_API_PORT`,
  `EXTRANET_FILES_PORT`, `EXTRANET_PROXY_PORT` (legacy `EXTRANET_PORT` means
  the proxy).
- Old single-server `config.json` (`httpPort` + `mounts`) migrates on load:
  `mounts` become `routes`, `httpPort` becomes `proxyPort`; the file itself
  is only rewritten on the next save.

## Security model

- The server is read-only. Guests can list, view and download, never write.
- Every guest folder request is resolved against the share's folder; escaping
  it (`..`, symlinks pointing outside, UNC tricks) returns "nothing here".
- Share PINs: guessing is throttled — 30 wrong entries in 10 minutes from one
  address pauses that address for 15 minutes. PINs are not logged or visible
  to guests (the cookie is a hash, not the PIN itself). The owner's own
  computer (localhost) never needs a PIN.
- The admin console, its APIs and `/analytics`:
  - always open from `localhost` (the computer running the server),
  - from other devices only with the **admin token** printed at startup,
  - never reachable through the public Cloudflare link (403 there).
- The API service trusts localhost without a token; from the LAN the admin
  token is required.
- Blocklist applies to guest traffic from that address (Wi-Fi **and** internet
  link); this computer (localhost) can never be blocked or locked out.
- Shares are opt-in: nothing is served until you add one.

## Rebuilding the UI

The web service serves the prebuilt bundle in `app/dist/` (pages at `/`,
`/admin`, `/analytics`; assets under `/app/assets/`). To change the design:

```
npm run setup       # once — installs React/Vite/Tailwind/shadcn deps inside app/
npm run build       # rebuilds app/dist from app/src
```

`app/dist/` is gitignored: the launcher builds it itself when it's missing
(and a build toolchain is installed), and an npm-packaged copy carries it via
the `files` list built right before publishing. For live-reload UI work:
`npm run setup`, run `npm start`, then `npm run dev` inside `app/` and open
the Vite URL — API calls are proxied to the API service automatically. To
check that the four pages still boot against a running server:
`npm run smoke` (it picks up the proxy port from `EXTRANET_PORT` or
`data/config.json`).

## Files it creates

```
bin/                 the npx launcher
server/              the four services + supervisor
app/                 the real shadcn/ui frontend (React + Tailwind)
app/dist/            the compiled UI the web service serves (gitignored, built from app/)
data/config.json     settings, route registry (with their PINs), recent folders, blocked IPs
data/runtime.json    the ports the four services actually bound (written per service)
data/logs.json       access log for /analytics (last 3000 requests + 600 clients), proxy-owned
data/bin/            cloudflared, if you used "Set up"
```

## Notes

- First run on Windows: allow **Node.js** on *private networks* in the firewall
  prompt, or guests can't connect.
- If a phone can't reach the server, it's almost always the firewall prompt,
  router "AP/client isolation", or being on a different network (guest Wi-Fi).
- The public link is someone's whole-internet access — only mark folders
  **Internet** that you're comfortable with strangers seeing (the PIN gate
  helps here; you can also always stop the link or un-mark the share).
- App-port shares repair root-absolute HTML/CSS references and give
  runtime-built URLs a fallback path (see "App-port shares" above), so apps
  usually work as-is. An app-side base-path setting is still the cleaner
  mechanism when one exists, but it's no longer required.
- iOS PDF preview can be stubborn inside the page; use the download button or
  "open in new tab" there.
- If a service worker crashes, the supervisor restarts it within a second or
  two and guest traffic dips briefly (a 502) before recovering on its own.

## Troubleshooting cloudflared

Start logs are kept in memory; if the tunnel errors, the console shows the
last message under the Internet link section.

## Development checks

Run `npm test` for isolated backend stability checks (temporary data only),
`npm run typecheck` for frontend TypeScript validation, and `npm run build`
for the production UI. The backend checks cover config migration, failed saves,
malformed config, occupied ports, concurrent startup, and API crash recovery.

Config saves replace the file atomically. If an existing config cannot be read,
startup fails with its path rather than replacing shares or credentials with
fresh defaults. A running config watcher retains its last valid state if a
reload fails. Correct the config file before restarting.
