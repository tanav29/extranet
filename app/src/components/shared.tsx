import { useEffect, useMemo, useState } from "react";
import {
  BarChart3, Copy, FolderOpen, Globe, Link2, Moon, QrCode, Sun, Wifi,
} from "lucide-react";
import { api, baseUrl, copyText, getToken, primaryIP } from "@/lib/api";
import { setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* ---------------------------------------------------------------- */
/* Theme (light / dark, persisted; html carries the class)           */
/* ---------------------------------------------------------------- */

const THEME_KEY = "extranet.theme";

export function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem(THEME_KEY, next ? "dark" : "light"); } catch { /* private mode */ }
  }
  return { dark, toggle };
}

function ThemeToggle() {
  const { dark, toggle } = useDarkMode();
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Switch to light" : "Switch to dark"}
      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* Token gate                                                        */
/* ---------------------------------------------------------------- */

export function Gate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const { dark, toggle } = useDarkMode();

  async function go() {
    setBusy(true);
    setErr("");
    setToken(value.trim());
    try {
      await api("/api/state");
      onDone();
    } catch (e: any) {
      setErr(e.message && e.message !== "token needed" ? e.message : "wrong token");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-muted/30 px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-3 grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Link2 className="size-4" />
        </div>
        <h1 className="text-[15px] font-semibold">Extranet admin</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          Enter the admin token printed when the server started.
        </p>
        <input
          data-slot="input"
          className="mt-4 flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 text-center"
          placeholder="admin token"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        <Button className="mt-2 w-full" disabled={busy} onClick={go}>Continue</Button>
        {err && <p className="mt-2 text-[12.5px] text-destructive">{err}</p>}
        <div className="mt-4 border-t pt-3">
          <button type="button" onClick={toggle} className="mx-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
            {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            {dark ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* App shell — desktop-style frame: fixed sidebar, scrolling canvas   */
/* ---------------------------------------------------------------- */

const NAV = [
  { key: "admin", href: "/admin", label: "Console", icon: FolderOpen, hint: "Shares, network, internet link" },
  { key: "analytics", href: "/analytics", label: "Analytics", icon: BarChart3, hint: "Traffic and blocking" },
] as const;

export function AppShell({
  page, host, children,
}: { page: "admin" | "analytics"; host?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* sidebar — hidden on small screens, replaced by a slim top bar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Link2 className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[14.5px] font-semibold leading-tight tracking-tight">Extranet</div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">file server</div>
          </div>
        </div>

        <nav className="mt-3 flex flex-col gap-0.5 px-2" aria-label="Main">
          {NAV.map((n) => {
            const active = page === n.key;
            const Icon = n.icon;
            return (
              <a
                key={n.key}
                href={n.href}
                title={n.hint}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                  active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {n.label}
              </a>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1.5 px-2 pb-3">
          <ThemeToggle />
          {host && (
            <div className="flex items-center gap-2 rounded-md border px-2.5 py-2">
              <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground" title={host}>{host}</span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* compact top bar for small screens */}
        <header className="flex items-center gap-2 border-b bg-card px-3 py-2 md:hidden">
          <div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Link2 className="size-3.5" />
          </div>
          <span className="text-[13px] font-semibold">Extranet</span>
          <nav className="ml-auto flex items-center gap-1" aria-label="Main">
            {NAV.map((n) => {
              const active = page === n.key;
              const Icon = n.icon;
              return (
                <a
                  key={n.key}
                  href={n.href}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {n.label}
                </a>
              );
            })}
          </nav>
        </header>

        {/* the canvas scrolls; the frame stays put */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/30">{children}</main>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Page header (used inside the canvas)                              */
/* ---------------------------------------------------------------- */

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-[15.5px] font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>}
      </div>
      <div className="flex-1" />
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Section card                                                      */
/* ---------------------------------------------------------------- */

export function SectionCard({
  icon, title, action, children, bodyClass, className,
}: { icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode; bodyClass?: string; className?: string }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-sm", className)}>
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <div className="flex-1" />
        {action}
      </div>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Status chips (the little facts that matter at a glance)           */
/* ---------------------------------------------------------------- */

export function StatusChip(
  { icon, children, tone }: { icon: React.ReactNode; children: React.ReactNode; tone?: "live" | "warn" },
) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px] text-muted-foreground",
        tone === "warn" && "border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400",
      )}
    >
      <span className="[&_svg]:size-3.5">{icon}</span>
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* QR dialog (kept small so it never overflows)                      */
/* ---------------------------------------------------------------- */

export function QRDialog({
  state, sharePath, tunnelUrl, pin, onClose,
}: {
  state: any;
  sharePath: string;
  tunnelUrl?: string | null;
  pin?: string | null;
  onClose: () => void;
}) {
  const targets = useMemo(() => {
    const list: { label: string; url: string }[] = [];
    for (const it of state.ips || []) {
      list.push({ label: `${it.address}:${state.ports.proxy} — ${it.name}`, url: baseUrl(state, it.address) });
    }
    if (!list.length) list.push({ label: `localhost:${state.ports.proxy}`, url: baseUrl(state, null) });
    return list;
  }, [state]);

  const [conn, setConn] = useState<string>(() => tunnelUrl || targets[0]?.url || "");

  const pinSuffix = pin ? `?pin=${encodeURIComponent(pin)}` : "";
  const url = conn + (sharePath || "").replace(/\/+$/, "") + "/" + pinSuffix;
  const src = `/api/qr?u=${encodeURIComponent(url)}&t=${encodeURIComponent(getToken())}`;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[340px]">
        <DialogHeader>
          <DialogTitle>Scan to open</DialogTitle>
          <DialogDescription>Point a phone camera at the code.</DialogDescription>
        </DialogHeader>

        <div className="mx-auto grid aspect-square w-44 max-w-full place-items-center overflow-hidden rounded-lg border bg-white p-1.5">
          {state.qrAvailable ? (
            <img src={src} alt="QR code" className="h-full w-full object-contain" />
          ) : (
            <p className="p-3 text-center text-xs text-muted-foreground">QR unavailable — the “qrcode” package is missing.</p>
          )}
        </div>

        <Select value={conn} onValueChange={setConn}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.url} value={t.url}>{t.label}</SelectItem>
            ))}
            {tunnelUrl && (
              <SelectItem value={tunnelUrl}>internet link (public)</SelectItem>
            )}
          </SelectContent>
        </Select>

        <p className="break-all text-center font-mono text-[11px] text-muted-foreground">{url}</p>
        {pin && (
          <p className="text-center text-[11px] text-muted-foreground">
            This link carries its <span className="font-medium text-foreground">PIN once</span> — guests won't need to type it.
          </p>
        )}

        <Button variant="outline" className="w-full" onClick={() => copyText(url).then(() => toast.success("Link copied"))}>
          <Copy /> Copy link
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- */
/* Small shared bits                                                 */
/* ---------------------------------------------------------------- */

export function IconBtn({
  title, onClick, children, destructive, asChild,
}: {
  title: string; onClick?: () => void; children: React.ReactNode; destructive?: boolean; asChild?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={title}
      onClick={onClick}
      asChild={asChild}
      className={destructive
        ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
        : "text-muted-foreground"}
    >
      {children}
    </Button>
  );
}

export function ScopeSwitches({
  lan, pub, onLan, onPub,
}: { lan: boolean; pub: boolean; onLan: (v: boolean) => void; onPub: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3">
      <label className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground" title="Reachable from this Wi-Fi">
        <Wifi className="size-3.5" />
        <Switch checked={lan} onCheckedChange={onLan} />
      </label>
      <label className="flex items-center gap-1.5 text-[11.5px] font-medium text-muted-foreground" title="Reachable through the internet link">
        <Globe className="size-3.5" />
        <Switch checked={pub} onCheckedChange={onPub} />
      </label>
    </div>
  );
}
