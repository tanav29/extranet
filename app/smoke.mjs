import { Window } from "happy-dom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const base = path.dirname(fileURLToPath(import.meta.url)); // app/
const pub = path.resolve(base, "dist", "assets");

/* the running server's port: EXTRANET_PORT, data/config.json, else the default */
function serverOrigin() {
  if (process.env.EXTRANET_PORT) return `http://localhost:${process.env.EXTRANET_PORT}`;
  try {
    const cfgRoot = path.resolve(base, "..", "data");       // repo layout
    const cfgHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".extranet", "data");
    for (const dir of [cfgRoot, cfgHome]) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
        if (cfg.httpPort) return `http://localhost:${cfg.httpPort}`;
      } catch { /* try the next one */ }
    }
  } catch { /* default below */ }
  return "http://localhost:5050";
}
const ORIGIN = serverOrigin();

function entryChunk(prefix) {
  const files = fs.readdirSync(pub).filter((f) => f.startsWith(prefix + "-") && f.endsWith(".js"));
  return files.sort((a, b) => fs.statSync(path.join(pub, b)).size - fs.statSync(path.join(pub, a)).size)[0];
}

const SKIP = new Set(["window", "document", "globalThis", "top", "parent", "self", "frames", "console"]);

async function boot(url, prefix, checks) {
  const win = new Window({ url });
  win.document.body.innerHTML = '<div id="root"></div>';

  // expose the DOM world to node so react/radix code paths can run
  for (const key of Object.getOwnPropertyNames(win)) {
    if (SKIP.has(key)) continue;
    if (typeof globalThis[key] === "undefined") {
      try { globalThis[key] = win[key]; } catch { /* read-only */ }
    }
  }
  // relative fetch must resolve against the happy-dom window URL (Node fetch cannot)
  globalThis.fetch = (input, init) => win.fetch(input, init);
  globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  Object.defineProperty(globalThis, "document", { value: win.document, configurable: true });
  Object.defineProperty(globalThis, "location", { value: win.location, configurable: true });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: win.localStorage, configurable: true });

  const chunk = path.join(pub, entryChunk(prefix));
  try {
    await import(pathToFileURL(chunk).href);
  } catch (e) {
    return { ok: false, error: "import failed: " + (e.stack || e).slice(0, 500) };
  }
  await new Promise((r) => setTimeout(r, 1200));
  const html = win.document.body.innerHTML;
  const missing = checks.filter((c) => !html.includes(c));
  const crashed = html.includes("This item does not exist") || html.includes("The server said");
  return { ok: missing.length === 0 && !crashed, missing, crashed, len: html.length, html: html.slice(0, 220) };
}

const results = [];
results.push(["home", await boot(`${ORIGIN}/`, "home", ["Hi 👋", "Shared on this computer", "read-only"])]);
results.push(["admin", await boot(`${ORIGIN}/admin`, "admin", ["This network", "Shared folders", "Internet link", "Analytics"])]);
results.push(["analytics", await boot(`${ORIGIN}/analytics`, "analytics", ["Analytics", "Request log", "Clients"])]);
results.push(["browse", await boot(`${ORIGIN}/movies/`, "browse", ["Download all", "items"])]);

let fail = false;
for (const [name, r] of results) {
  if (r.ok) console.log(`PASS ${name} (${r.len} chars)`);
  else { fail = true; console.log(`FAIL ${name}: missing=${JSON.stringify(r.missing)} crashed=${r.crashed} len=${r.len} head=${r.html} err=${r.error || "-"}`); }
}
process.exit(fail ? 1 : 0);
