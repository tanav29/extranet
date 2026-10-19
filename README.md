# Extranet

Share folders from your computer with the people around you — over your Wi-Fi,
or with anyone anywhere through a Cloudflare link.

Guests get a dead-simple page: browse folders, view photos / PDFs / video / text
right in the browser, and download anything (or a whole folder as a single
`.zip`).

The backend is a **Fastify** Node.js server (`server.js`), and the frontend is a
plain **React** app (`web/`, Vite + Tailwind) that compiles into `public/app/`
and is served statically — no server-side templating.

```
npm start
```

Then open **http://localhost:5050/admin** on the same computer.

## What you get

- **Real shadcn/ui** — the admin console, the guest page, and analytics are
  built with actual shadcn/ui components (React + Tailwind + Radix) in `web/`,
  compiled into `public/app/` and served statically. Bump the design by
  editing `web/src` and rebuilding.
- **Shares** — map any folder to a short web address, e.g. `D:\Movies` → `/movies`.
  Guests open `https://<your-ip>:5443/movies/`. Each share can be visible on the
  Wi-Fi, through the internet link, or both.
- **Folders you shared are remembered** — after you unshare (or restart), the
  folder stays in the "Recent" chips of the add form and the folder picker, so
  re-sharing is one click, not a re-browse.
- **Your addresses** — the admin page lists every LAN IP of this computer, and
  every share has a **QR** button (also for the public link while it's running).
  The QR dialog is deliberately small so it never overflows on phones.
- **Analytics** — a `/analytics` page (same admin protection) with:
  - every guest request to shares: time, IP, method, path, status, bytes,
    share name, blocked flag,
  - aggregated **clients**: how much each IP took, device guess, last seen,
  - **blocking**: one click blocks an address — blocked IPs get a 403 on all
    guest traffic (localhost is always safe). Unblock anytime. Logs keep the
    last 3000 requests + 600 clients and survive restarts (`data/logs.json`);
    the web UI can auto-refresh 5s live.
- **HTTPS** — a self-signed certificate is generated on first run. Browsers show
  a one-time warning; guests choose "proceed / visit website" and everything
  works, including video seeking and PDFs.
- **Internet link** — one click runs `cloudflared` as a *quick tunnel* and gives
  a random `https://something.trycloudflare.com` address you can send to anyone.
  You don't need a Cloudflare account, and nothing is permanently exposed: the
  link is live only while the tunnel runs, and each run gets a fresh address.
  If cloudflared isn't installed, the admin page downloads it for you (Windows)
  or tells you what to install (`brew install cloudflared` / `apt install cloudflared`).
- **Receiver page** — minimal list with previews (image, video, audio, PDF,
  text/code), per-file downloads, prev/next between files, a search box, and
  "Download all (.zip)" for the current folder.

## Rebuilding the UI

The server serves the prebuilt bundle in `public/app/`. To change the design:

```
npm run setup:web   # once — installs React/Vite/Tailwind/shadcn deps
npm run build:web   # rebuilds public/app from web/src
```

For live-reload UI work: `npm run setup:web`, run `npm start` in the repo root
(the Fastify server), then `npm run dev` inside `web/` and open the Vite URL —
API calls are proxied to the Fastify server automatically. To check that all
three pages still boot against a running server: `npm run smoke`.

## Ports

Defaults: HTTP **5050**, HTTPS **5443** (both editable in the admin page; the
server hops to the next free port if one is taken and remembers it).

## Security model

- The server is read-only. Guests can list and download, never write.
- Every guest request is resolved against the share's folder; escaping it
  (`..`, symlinks pointing outside, UNC tricks) returns "nothing here".
- The admin console, its APIs and `/analytics`:
  - always open from `localhost` (the computer running the server),
  - from other devices only with the **admin token** printed at startup,
  - never reachable through the public Cloudflare link.
- Blocklist applies to guest traffic from that address (Wi-Fi **and** internet
  link); this computer (localhost) can never be blocked or locked out.
- Shares are opt-in: nothing is served until you add a folder.

## Files it creates

```
web/                 the real shadcn/ui frontend (React + Tailwind)
public/app/          the compiled UI the server serves
data/config.json     settings, shares, recent folders, blocked IPs
data/logs.json       access log for /analytics (last 3000 requests)
data/certs/          the self-signed HTTPS certificate
bin/                 cloudflared.exe, if you used "Set up"
```

## Notes

- First run on Windows: allow **Node.js** on *private networks* in the firewall
  prompt, or guests can't connect.
- If a phone can't reach the server, it's almost always the firewall prompt,
  router "AP/client isolation", or being on a different network (guest Wi-Fi).
- The public link is someone's whole-internet access — only mark folders
  **Internet** that you're comfortable with strangers seeing (there's no login
  on the link; you can always stop the link or un-mark the share).
- iOS PDF preview can be stubborn inside the page; use the download button or
  "open in new tab" there.

## Troubleshooting cloudflared

Start logs are kept in memory; if the tunnel errors, the admin page shows the
last message under the Internet link section.
