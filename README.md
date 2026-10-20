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

Then open **http://localhost:5050/admin** on the same computer.

## Project layout

```
bin/cli.js           the launcher — the only thing you run (npx / npm start)
server/index.js      the Fastify server app: shares, PINs, proxying, ZIP, analytics
app/                 the Vite + React + Tailwind source (admin, guest, analytics)
app/dist/            the compiled UI the server serves (gitignored; built on demand)
data/                runtime data: config.json, logs.json, cloudflared helper
```

Backend = one self-contained Fastify app in `server/`. Frontend = one Vite app
in `app/`, built into `app/dist/` — no server-side templating. Fonts load from
Google Fonts at runtime, so no font files live in the repo. Everything is
started through `bin/cli.js`, so `npx`, `npm start` and a symlinked global
install all behave the same. Runtime data lives in `data/` next to the repo;
for an installed copy it moves to `~/.extranet/data`. `--port <n>` (or the
`EXTRANET_PORT` env var) overrides the saved port without touching config.

Useful flags: `npx . --port 6060`, `npx . --build` (rebuild the UI), `npx . --help`.

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
  `D:\Movies` → `/movies`. Guests open `http://<your-ip>:5050/movies/`.
  Each share can be visible on the Wi-Fi, through the internet link, or both.
- **App-port shares** — expose anything already running on this computer under
  the same style of address: `/webapp` → `127.0.0.1:3000`. The share works like
  any other (Wi-Fi scope, internet scope, PIN). Every request under the address
  is forwarded to that local port with the prefix stripped; websockets are not
  supported.
  Apps usually expect to own a whole site: they write root-absolute paths
  (`/static/app.css`), absolute form actions, and `Location: /login` — fine at
  an origin of their own, broken under a path. The share repairs that on its
  own, without subdomains or an app-side base-path setting: opening
  `/webapp` redirects to `/webapp/`, complete (uncompressed, reasonably small)
  HTML and CSS responses are rewritten in place so root-absolute references
  resolve under the share, `Set-Cookie: Path=/` and `Location:` headers are
  repointed, and URLs the app's JavaScript builds at runtime
  (`fetch('/api/…')` and friends) reach the app through a fallback rule: while
  exactly one app share is visible to a visitor, unmatched paths go to it too.
  Streamed, compressed or oversized responses pass through untouched; inline
  `<script>` bodies keep their exact bytes. With two or more app shares
  visible at once the fallback is ambiguous and unmatched paths show the
  not-found page.
- **One-time PIN lock (6 digits)** — any share can require a 6-digit PIN.
  Guests either open a link that carries it (`/movies/?pin=123456`) or type it
  on a small lock page. Their browser remembers it for 6 months, so nobody has
  to re-enter it on every visit. Copies and QR codes from the admin page
  include the PIN automatically, and the PIN never shows up in the access log.
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
    guest traffic (localhost is always safe). Unblock anytime. Logs keep the
    last 3000 requests + 600 clients and survive restarts (`data/logs.json`);
    the web UI can auto-refresh 5s live.
- **Internet link** — one click runs `cloudflared` as a *quick tunnel* and gives
  a random `https://something.trycloudflare.com` address you can send to anyone.
  You don't need a Cloudflare account, and nothing is permanently exposed: the
  link is live only while the tunnel runs, and each run gets a fresh address.
  If cloudflared isn't installed, the app downloads it for you (Windows) or
  tells you what to install (`brew install cloudflared` / `apt install cloudflared`).
- **Receiver page** — minimal list with previews (image, video, audio, PDF,
  text/code), per-file downloads, prev/next between files, a search box, and
  "Download all (.zip)" for the current folder.

## Rebuilding the UI

The server serves the prebuilt bundle in `app/dist/`. To change the design:

```
npm run setup       # once — installs React/Vite/Tailwind/shadcn deps inside app/
npm run build       # rebuilds app/dist from app/src
```

`app/dist/` is gitignored: the launcher builds it itself when it's missing
(and a build toolchain is installed), and an npm-packaged copy carries it via
the `files` list built right before publishing. For live-reload UI work:
`npm run setup`, run `npm start` (the Fastify server), then `npm run dev`
inside `app/` and open the Vite URL — API calls are proxied to the Fastify
server automatically. To check that the three pages still boot against a
running server: `npm run smoke` (it picks up the running port from
`EXTRANET_PORT` or `data/config.json`).

## Ports

Default: HTTP **5050** (editable in the console; the server hops to the next
free port if it's taken and remembers it. `--port` / `EXTRANET_PORT` override
it for one run without changing the saved config). Guest links are plain
`http://` — the old self-signed HTTPS mode was removed on purpose: guests had
to click through browser warnings, and the tunnel link already gives proper
HTTPS when used over the internet.

## Security model

- The server is read-only. Guests can list, view and download, never write.
- Every guest folder request is resolved against the share's folder; escaping
  it (`..`, symlinks pointing outside, UNC tricks) returns "nothing here".
- Share PINs: guessing is throttled — 30 wrong entries in 10 minutes from one
  address pauses that address for 15 minutes. PINs are not logged or visible to
  guests (the cookie is a hash, not the PIN itself). The owner's own computer
  (localhost) never needs a PIN.
- The admin console, its APIs and `/analytics`:
  - always open from `localhost` (the computer running the server),
  - from other devices only with the **admin token** printed at startup,
  - never reachable through the public Cloudflare link.
- Blocklist applies to guest traffic from that address (Wi-Fi **and** internet
  link); this computer (localhost) can never be blocked or locked out.
- Shares are opt-in: nothing is served until you add one.

## Files it creates

```
bin/                 the npx launcher
server/index.js      the Fastify server
app/                 the real shadcn/ui frontend (React + Tailwind)
app/dist/            the compiled UI the server serves (gitignored, built from app/)
data/config.json     settings, shares (with their PINs), recent folders, blocked IPs
data/logs.json       access log for /analytics (last 3000 requests)
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

## Troubleshooting cloudflared

Start logs are kept in memory; if the tunnel errors, the console shows the
last message under the Internet link section.
