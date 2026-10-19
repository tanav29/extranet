import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Folder, Globe, Link2, Monitor, QrCode, Search, Trash2, Wifi } from "lucide-react";
import { api, baseUrl, copyText, getToken, primaryIP } from "@/lib/api";
import { setToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

/* ---------------------------------------------------------------- */
/* Token gate                                                        */
/* ---------------------------------------------------------------- */

export function Gate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setErr("");
    setToken(value.trim());
    try {
      await api("/admin/api/state");
      onDone();
    } catch (e: any) {
      setErr(e.message && e.message !== "token needed" ? e.message : "wrong token");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
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
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* App shell (header + nav)                                          */
/* ---------------------------------------------------------------- */

function navCls(active: boolean) {
  return "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors " +
    (active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground");
}

export function AppShell({
  page, host, children,
}: { page: "admin" | "analytics"; host?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <div className="mx-auto max-w-2xl px-5 pb-24">
        <header className="flex items-center gap-3 py-6">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Link2 className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight tracking-tight">Extranet</div>
            {host && (
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span className="truncate">{host}</span>
              </div>
            )}
          </div>
          <nav className="ml-auto flex items-center gap-1">
            <a href="/admin" className={navCls(page === "admin")}>Admin</a>
            <a href="/analytics" className={navCls(page === "analytics")}>Analytics</a>
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Section card                                                      */
/* ---------------------------------------------------------------- */

export function SectionCard({
  icon, title, action, children,
}: { icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4 overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2.5 border-b px-4 py-3">
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
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
      list.push({ label: `${it.address}:${state.ports.http} — ${it.name}`, url: baseUrl(state, it.address) });
    }
    if (!list.length) list.push({ label: `localhost:${state.ports.http}`, url: baseUrl(state, null) });
    return list;
  }, [state]);

  const [conn, setConn] = useState<string>(() => tunnelUrl || targets[0]?.url || "");

  const pinSuffix = pin ? `?pin=${encodeURIComponent(pin)}` : "";
  const url = conn + (sharePath || "").replace(/\/+$/, "") + "/" + pinSuffix;
  const src = `/admin/qr?u=${encodeURIComponent(url)}&t=${encodeURIComponent(getToken())}`;

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
      className={destructive ? "text-destructive hover:bg-red-50 hover:text-destructive" : "text-muted-foreground"}
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

export function MountBadges({ m }: { m: any }) {
  return (
    <div className="flex items-center gap-1.5">
      {m.lan && <Badge variant="secondary" className="gap-1"><Wifi className="size-3" />Wi-Fi</Badge>}
      {m.public && <Badge variant="secondary" className="gap-1"><Globe className="size-3" />Internet</Badge>}
      {!m.lan && !m.public && <Badge variant="outline">off</Badge>}
    </div>
  );
}