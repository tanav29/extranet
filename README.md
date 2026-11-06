# Extranet

Share folders and apps from your computer over Wi-Fi or through a temporary
internet link. Guests use their browser; they do not need to install anything.

Choose what to share, who can reach it, and whether to require a six-digit PIN.
Guests can browse folders, preview photos, PDFs, video, audio, and text, download
files, or download a folder as a ZIP. Copy a link or display a QR code to share.
The admin console includes request history and controls for blocking guest IPs.

## Requirements

- **Node.js 20.17 or newer**, with npm.
- Windows, macOS, or Linux. Automated runtime checks have currently been run on Windows.
- Permission to read the folders you share.
- For Wi-Fi sharing, a network that allows your devices to communicate.
- For public links, internet access and `cloudflared`. Wi-Fi sharing works without it.

Your computer must stay awake and Extranet must keep running while guests use it.

## Get started

Use this setup from the repository. Availability of the `extranet` name on the
npm registry is not assumed.

```sh
git clone https://github.com/tanav29/extranet.git
cd extranet
npm run setup
npm run build
npm start
```

`setup` installs locked backend and frontend dependencies. `build` compiles
TypeScript and builds the UI. `start` compiles the backend and starts all services.

Open **http://localhost:8787/admin** on this computer. If that port is occupied,
use the actual address printed in the terminal. On Windows, allow Node.js through
the firewall on your private network when prompted. Keep the terminal open.
Press **Ctrl+C** to stop Extranet.

### Share a folder

1. Open the admin console and add a folder share.
2. Choose a folder and an address such as `photos`.
3. Enable Wi-Fi visibility. Optionally set a six-digit PIN.
4. Save, then copy the Wi-Fi link or display its QR code.
5. Open the link on another device on the same network.

Example guest address:

```text
http://<your-computer-ip>:8787/files/photos/
```

Folder sharing is read-only: guests can browse, preview, and download, but cannot
upload, edit, or delete. Removing a share revokes access through Extranet without
deleting the original folder.

### Send an internet link

1. Enable internet visibility for the share.
2. In **Internet link**, set up `cloudflared` if needed. Extranet can download it
   on Windows. On macOS or Linux, install it separately and put it on your PATH.
3. Start the internet link and wait for its public address.
4. Copy the share's public link or QR code.

The address looks like `https://<random-name>.trycloudflare.com`. Only shares
with internet visibility are accessible through it. The admin console and
analytics are blocked through the public link.

Stopping the tunnel closes the link. Starting a new tunnel produces a new
address, so send the updated link to guests. You can also turn off internet
visibility for one share while leaving the tunnel running.

### Share an app

Start the app on this computer, then add an app-port share using its actual
listening port. An address such as `demo` produces:

```text
http://<your-computer-ip>:8787/demo/
```

Extranet's internal web service prefers port 3000. If your app uses that port,
start it first or give it a different port.

HTTP, WebSockets, and event streams are forwarded through each share's prefix.
HTML/CSS links, redirects, and cookie paths are repaired. Apps must generate
API, navigation, and socket URLs under their share prefix: configure the app's
public base path and router basename when available. Root requests never use
Referer or a last-opened-app cookie to guess a destination.

In **Edit share**, choose whether to remove the prefix before forwarding (the
upstream serves at `/`) or keep it (the upstream serves at the same prefix).
Set an optional start page, such as `/pair`.

For T3 Code, share port **3773** at **`/t3`**. The T3 compatibility adapter is
selected automatically for that port; select it manually for T3 on another port.
It supplies the TanStack router base path, repairs Vite preload URLs, and routes
browser API/socket requests under `/t3/`. The default start page is `/pair`.
The adapter targets T3's current Vite/TanStack build and may need an update if
T3 changes its bundle format. It does not modify the T3 installation.

Generic apps without base-path support may require their own adapter or a
separate hostname. Compressed and oversized responses pass through without
content rewriting; the proxy requests uncompressed content for adapted files.
Streaming responses are forwarded without rewriting. Prefixes share a browser
origin, including browser storage; use them for trusted apps, not origin isolation.

An app share can expose the app's own write actions and permissions. The
read-only restriction applies to Extranet folder shares.

## Install a standalone command

From a checkout with dependencies installed, create a distributable package:

```sh
npm pack
```

This builds the backend and UI and creates `extranet-1.0.0.tgz`. Copy that file
to the destination computer, then run:

```sh
npm install --global ./extranet-1.0.0.tgz
extranet
```

Use the filename printed by `npm pack` if the version changes. The package
includes compiled JavaScript and the built UI. End users need Node.js and npm,
but do not need TypeScript, Vite, Git, or frontend build tools. Use `extranet`
for an installed package; `npm start` is for source checkouts. These commands
do not publish anything to the npm registry.

To update, stop Extranet, install a newer tarball using the same command, and
start it again. Saved data is stored outside the installed package.

## Addresses and access

- `/`: guest directory showing visible shares.
- `/admin`: share, network, and internet-link management.
- `/analytics`: request history, clients, and blocking controls.
- `/files/<name>/`: a folder share.
- `/<name>/`: an app share.

Local management does not need a token. Management API calls from another LAN
device require the admin token printed at startup. Keep it private. Share PINs
are separate from the admin token. Localhost bypasses share PINs; test PIN entry
from another device.

Copied share links and QR codes include the PIN when one is configured. Anyone
with that link has the PIN. Wi-Fi links use plain HTTP; public tunnel links use
HTTPS. Share folders and apps intended for the selected audience.

## Saved data and backups

Shares, settings, recent folders, and blocked IPs survive restarts. Original file
contents stay in their folders and are streamed when requested.

Data lives in `data/` in a checkout **if that directory already exists**;
otherwise it lives in `~/.extranet/data` (`%USERPROFILE%\.extranet\data` on
Windows). Standalone installs normally use the home-directory location.
Set `EXTRANET_DATA_DIR` to an absolute path to choose a predictable location.

```text
config.json     Shares, PINs, admin token, settings, recent folders, blocked IPs
runtime.json    Current run ID, service PIDs, and ports; regenerated on startup
logs.json       Recent request history and client statistics
bin/            cloudflared binary, if installed through Extranet
```

To back up settings, stop Extranet and copy `config.json` to a private location.
Restore it to the same data directory before restarting. Back up shared folders
separately. The config contains credentials and local folder paths.

Saves are atomic. A malformed or unreadable existing config causes startup to
fail rather than replacing your settings. Restore a valid backup or correct the
file named in the error, then restart.

### Change ports

From a checkout:

```sh
npm start -- --port 6060
```

From a standalone install:

```sh
extranet --port 6060
```

This override applies to the current run. You can save a proxy port in the
console for future runs; a command-line override takes precedence. Occupied
ports are skipped, so use the actual address printed at startup.

Advanced environment variables, set in your shell before launching:

- `EXTRANET_DATA_DIR`: persistent data location.
- `EXTRANET_PUBLIC_DIR`: built frontend directory.
- `EXTRANET_PORT` or `EXTRANET_PROXY_PORT`: proxy port override.
- `EXTRANET_WEB_PORT`, `EXTRANET_API_PORT`, `EXTRANET_FILES_PORT`: internal preferred ports.

Only the proxy listens on all network interfaces. Internal services bind to loopback.

## Troubleshooting

**Another device cannot connect:** use the LAN link, rather than `localhost`.
Check the host firewall, both devices' networks, and router client isolation
or guest Wi-Fi restrictions.

**A share is missing:** check Wi-Fi/internet visibility, that its folder still
exists, and that Extranet can read it.

**The public link stopped working:** keep the computer awake, confirm the tunnel
is running, and copy its current URL. Tunnel errors appear under Internet link.
Check that `cloudflared` is installed and can access the internet.

**An app partially loads:** check its actual port, base-path support, and whether
its API/socket URLs retain the prefix. See the app-sharing settings above.

**The UI is missing:** run `npm run build` in a source checkout, then restart.
For standalone installs, reinstall a correctly built package. The `--build`
flag is only for rebuilding a source checkout's UI.

**Service unavailable:** crashed services restart automatically, up to ten
attempts. Inspect the `[web]`, `[api]`, `[files]`, or `[proxy]` terminal messages
if failures continue, address the cause, and restart.

## Development

The backend, CLI, tests, frontend, and smoke tooling are TypeScript. Backend and
test compilation uses strict type checking.

```text
bin/cli.ts          CLI source
server/index.ts     Supervisor and runtime registry
server/proxy.ts     Public HTTP edge, app forwarding, access logs
server/api.ts       Management API, tunnel control, guest directory
server/files.ts     Folder browsing, downloads, ZIP streaming
server/web.ts       Static UI service
server/lib.ts       Shared persistence, routing, and PIN helpers
server/types.ts     Shared domain types
app/src/            React UI
app/smoke.ts        Optional DOM smoke checks
test/               Isolated backend regression tests
dist/               Compiled backend, CLI, and tests (generated)
app/dist/           Built frontend (generated)
```

From the repository root:

```sh
npm run typecheck   # Backend, frontend, and tooling types
npm test            # Compile and run backend regression tests
npm run build       # Build backend and frontend
npm start           # Run the backend
```

For frontend development, keep `npm start` running in one terminal and run
`npm run dev` in another. Open the Vite address with `/app/admin.html` appended
for the admin interface. Vite proxies API requests to `http://localhost:8787`;
set `VITE_BACKEND` if the backend uses another address. Backend edits require
restarting `npm start`.

`npm run smoke` compiles and runs optional DOM checks against a running server
and built UI. It currently expects a folder share named `movies`. Use `npm test`
for isolated checks without existing shares.

The proxy prefers **8787**; internal web, API, and files services prefer **3000**,
**5000**, and **8080**. Children report readiness over IPC; the supervisor writes
`runtime.json`. Services read configuration and port changes from disk. The
proxy owns access logs. Packages include `dist/server/`, `dist/bin/`, and
`app/dist/`, so installation requires no compilation.
