import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Cable, Copy, Download, ExternalLink, Folder, FolderOpen, Globe,
  Info, KeyRound, LoaderCircle, Monitor, Pencil, Plus, QrCode, Search, ShieldBan,
  Trash2, Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { api, baseUrl, copyText, primaryIP } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AppShell, Gate, IconBtn, QRDialog, ScopeSwitches, SectionCard, StatusChip,
} from "@/components/shared";
import { cn } from "@/lib/utils";

type State = any;
type MountKind = "folder" | "port";

export default function AdminApp() {
  const [state, setState] = useState<State | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [qr, setQr] = useState<{ sharePath: string; tunnelUrl?: string | null; pin?: string | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<State>("/admin/api/state");
      setState(s);
      setNeedToken(false);
      setLoaded(true);
      return s;
    } catch (e: any) {
      if (e.status === 401) setNeedToken(true);
      else toast.error(e.message);
      return null;
    }
  }, []);

  useEffect(() => { (async () => {
    // seed a stored token if present, then try
    try {
      const s = await api<State>("/admin/api/state");
      setState(s); setLoaded(true);
    } catch (e: any) {
      if (e.status === 401) setNeedToken(true);
      else toast.error(e.message);
    }
  })(); }, []);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api("/admin/api/state").then((s) => setState(s)).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  if (needToken) {
    return <Gate onDone={() => refresh()} />;
  }

  if (!loaded || !state) {
    return (
      <div className="grid min-h-dvh place-items-center bg-muted/30 text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <AppShell page="admin" host={state.hostname}>
      <div className="mx-auto w-full max-w-6xl px-5 py-5 xl:px-8">
        <PageTop state={state} />

        {/* desktop layout: the share list is the main pane, network + internet
            link ride along in a side rail; on narrow screens everything stacks */}
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
          <SharesCard state={state} refresh={refresh} onQR={(sharePath, pin) => setQr({ sharePath, pin })} />
          <div className="grid gap-4">
            <TunnelCard state={state} refresh={refresh} onQR={(tunnelUrl) => setQr({ sharePath: "", tunnelUrl })} />
            <NetworkCard state={state} refresh={refresh} />
            <TokenNote state={state} />
          </div>
        </div>
      </div>
      {qr && <QRDialog state={state} sharePath={qr.sharePath} tunnelUrl={qr.tunnelUrl} pin={qr.pin} onClose={() => setQr(null)} />}
    </AppShell>
  );
}

/* ---------------------------------------------------------------- */
/* Page top: title + the facts that matter, as quiet chips           */
/* ---------------------------------------------------------------- */

function PageTop({ state }: { state: State }) {
  const mounts: any[] = state.mounts || [];
  const t = state.tunnel || {};
  const live = t.status === "running" && t.url;

  return (
    <div className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div>
        <h1 className="text-[15.5px] font-semibold tracking-tight">Console</h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">Share folders and app ports from this computer.</p>
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-1.5">
        <StatusChip icon={<FolderOpen />}>
          {mounts.length} {mounts.length === 1 ? "share" : "shares"}
        </StatusChip>
        <StatusChip icon={<Globe />}>
          {live ? "Internet link live" : t.status === "starting" ? "Link connecting…" : "Internet link off"}
        </StatusChip>
        {!!state.blockedCount && (
          <StatusChip tone="warn" icon={<ShieldBan />}>
            {state.blockedCount} blocked
          </StatusChip>
        )}
        <StatusChip icon={<Monitor />}>
          {(state.ips || []).length} network {(state.ips || []).length === 1 ? "address" : "addresses"}
        </StatusChip>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Shares — the main pane                                            */
/* ---------------------------------------------------------------- */

function slugOf(dir: string): string {
  const base = dir.trim().split(/[\\/]/).filter(Boolean).pop() || "";
  return "/" + base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function SharesCard({ state, refresh, onQR }: { state: State; refresh: () => Promise<any>; onQR: (sharePath: string, pin?: string | null) => void }) {
  const [addKind, setAddKind] = useState<MountKind>("folder");
  const [addPath, setAddPath] = useState("");
  const [addDir, setAddDir] = useState("");
  const [addPort, setAddPort] = useState("");
  const [addPin, setAddPin] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [lan, setLan] = useState(true);
  const [pub, setPub] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const recents: string[] = state.recentDirs || [];
  const mounts = state.mounts || [];

  function setDir(d: string) {
    setAddDir(d);
    if (!nameTouched) setAddPath(slugOf(d));
    setPickerOpen(false);
  }

  async function add() {
    if (!addPath.trim()) { toast.error("Pick a web address first"); return; }
    if (addKind === "folder" && !addDir.trim()) { toast.error("Pick a folder first"); return; }
    if (addKind === "port" && addPort.trim() === "") { toast.error("Which port should this address forward to?"); return; }
    setBusy(true);
    try {
      const body: any = {
        kind: addKind,
        path: addPath,
        lan,
        public: pub,
      };
      if (addKind === "folder") body.dir = addDir;
      if (addKind === "port") body.port = parseInt(addPort, 10);
      if (addPin.trim()) body.pin = addPin.replace(/[^\d]/g, "");
      await api("/admin/api/mounts", { method: "POST", body });
      setAddDir(""); setAddPath(""); setAddPort(""); setAddPin("");
      setNameTouched(false);
      await refresh();
      toast.success(addKind === "port"
        ? `Shared ${addPath} — forwards to port ${addPort}`
        : `Shared at ${addPath}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard
      icon={<FolderOpen />}
      title="Shared folders"
      bodyClass="flex flex-col min-h-full"
      action={mounts.length ? <span className="text-[11.5px] tabular-nums text-muted-foreground">{mounts.length} shared</span> : undefined}
    >
      {!mounts.length && (
        <div className="flex items-start gap-2.5 border-b px-4 py-4">
          <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-[13px] font-medium">Nothing shared yet</div>
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">
              Add folder or port shares below — guests get a clean page for browsing and downloading it.
            </div>
          </div>
        </div>
      )}
      {mounts.map((m: any) => (
        <ShareRow key={m.id} m={m} state={state} refresh={refresh} onQR={onQR} />
      ))}

      <div className="mt-auto border-t bg-muted/30 px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
          <Plus className="size-3.5" />
          Add a share
          <span className="ml-1 font-normal">
            {addKind === "folder" ? "— a folder from this computer" : "— an app running on this computer"}
          </span>
        </div>

        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <KindPick value={addKind} onChange={setAddKind} />
            <Input
              className="w-36 font-mono text-xs"
              placeholder="/web-address"
              value={addPath}
              onChange={(e) => { setAddPath(e.target.value); setNameTouched(true); }}
            />
            {addKind === "folder" ? (
              <>
                <Input
                  className="min-w-40 flex-1 font-mono text-xs"
                  placeholder="folder on this computer"
                  value={addDir}
                  onChange={(e) => setDir(e.target.value)}
                />
                <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}><Search />Browse</Button>
              </>
            ) : (
              <Input
                type="number"
                className="w-36 font-mono text-xs"
                placeholder="port (e.g. 3000)"
                min={1024}
                max={65535}
                value={addPort}
                onChange={(e) => setAddPort(e.target.value)}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Input
              className="w-44 font-mono text-xs"
              placeholder="PIN · 6 digits · optional"
              inputMode="numeric"
              maxLength={6}
              value={addPin}
              title="Guests enter this PIN once; their browser remembers it"
              onChange={(e) => setAddPin(e.target.value.replace(/[^\d]/g, ""))}
            />
            <ScopeSwitches lan={lan} pub={pub} onLan={setLan} onPub={setPub} />
            {recents.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Recent:</span>
                {recents.slice(0, 4).map((d) => (
                  <button
                    key={d}
                    title={d}
                    onClick={() => setDir(d)}
                    className="max-w-44 truncate rounded-md border bg-card px-2 py-1 font-mono text-[11px] text-secondary-foreground hover:bg-accent"
                  >
                    {d.split(/[\\/]/).filter(Boolean).pop() || d}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1" />
            <Button size="sm" disabled={busy} onClick={add}><Plus />Share</Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {addKind === "port"
              ? "Every request under the address is forwarded to that port on this computer (plain HTTP, no websockets)."
              : "The web address is the path guests see, like /photos. Keep it short and simple."}
          </p>
        </div>
      </div>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onUse={setDir}
        recents={recents}
      />
    </SectionCard>
  );
}

/* ---------------------------------------------------------------- */
/* Share kind picker                                                  */
/* ---------------------------------------------------------------- */

function KindPick({ value, onChange }: { value: MountKind; onChange: (v: MountKind) => void }) {
  const opt = (k: MountKind, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(k)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors",
        value === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="flex items-center rounded-md border p-0.5">
      {opt("folder", <Folder className="size-3.5" />, "Folder")}
      {opt("port", <Cable className="size-3.5" />, "App port")}
    </div>
  );
}

function ShareRow({ m, state, refresh, onQR }: { m: any; state: State; refresh: () => Promise<any>; onQR: (p: string, pin?: string | null) => void }) {
  const [lan, setLan] = useState(!!m.lan);
  const [pub, setPub] = useState(!!m.public);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => { setLan(!!m.lan); setPub(!!m.public); }, [m.lan, m.public]);

  async function patch(next: { lan?: boolean; public?: boolean }) {
    if (next.lan !== undefined) setLan(next.lan);
    if (next.public !== undefined) setPub(next.public);
    try {
      await api(`/admin/api/mounts/${m.id}`, { method: "PATCH", body: { ...m, ...next } });
      await refresh();
    } catch (e: any) {
      toast.error(e.message);
      setLan(!!m.lan); setPub(!!m.public);
    }
  }

  async function del() {
    if (!confirm(`Stop sharing ${m.path}? Guests lose access immediately.`)) return;
    try {
      await api(`/admin/api/mounts/${m.id}`, { method: "DELETE" });
      await refresh();
      toast.success(`Stopped sharing ${m.path}`);
    } catch (e: any) { toast.error(e.message); }
  }

  function shareUrl(): string {
    const t = state?.tunnel || {};
    const base = t.status === "running" && t.url && m.public ? t.url : baseUrl(state, primaryIP(state));
    return base + m.path + "/" + (m.pin ? `?pin=${encodeURIComponent(m.pin)}` : "");
  }

  return (
    <div className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-muted/40">
      <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/50 text-muted-foreground">
        {m.kind === "port" ? <Cable className="size-4" /> : <Folder className="size-4 text-zinc-500" />}
      </span>
      <div className="min-w-40 flex-1">
        <div className="flex items-center gap-1.5">
          <a href={shareUrl()} target="_blank" rel="noopener" className="truncate font-mono text-[12.5px] hover:underline">{m.path}/</a>
          {m.kind === "port" ? (
            <Badge variant="secondary" className="gap-1 font-normal"><Cable className="size-3" />:{m.port}</Badge>
          ) : null}
          {m.pin ? (
            <Badge variant="secondary" className="gap-1 font-normal"><KeyRound className="size-3" />PIN</Badge>
          ) : null}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={m.kind === "port" ? `127.0.0.1:${m.port}` : m.dir}>
          {m.kind === "port" ? `→ 127.0.0.1:${m.port}` : m.dir}
        </div>
      </div>
      <ScopeSwitches lan={lan} pub={pub} onLan={(v) => patch({ lan: v })} onPub={(v) => patch({ public: v })} />
      <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconBtn title="Copy link (includes the PIN when set)" onClick={() => copyText(shareUrl()).then(() => toast.success("Link copied"))}><Copy /></IconBtn>
        <IconBtn title="Show QR" onClick={() => onQR(m.path, m.pin)}><QrCode /></IconBtn>
        <IconBtn title="Edit address, port and PIN" onClick={() => setEditOpen(true)}><Pencil /></IconBtn>
        <IconBtn title="Open in browser" asChild>
          <a href={shareUrl()} target="_blank" rel="noopener"><ExternalLink /></a>
        </IconBtn>
        <IconBtn title="Stop sharing" destructive onClick={del}><Trash2 /></IconBtn>
      </div>
      <ShareEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        m={m}
        onDone={refresh}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Share edit dialog (address, port, PIN)                             */
/* ---------------------------------------------------------------- */

function ShareEditDialog({
  open, onOpenChange, m, onDone,
}: { open: boolean; onOpenChange: (o: boolean) => void; m: any; onDone: () => Promise<any> }) {
  const [path, setPath] = useState(m.path);
  const [port, setPort] = useState(String(m.port || ""));
  const [pin, setPin] = useState(m.pin || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPath(m.path);
    setPort(String(m.port || ""));
    setPin(m.pin || "");
  }, [open, m]);

  async function save() {
    setBusy(true);
    try {
      const body: any = { path, pin };
      if (m.kind === "port") body.port = parseInt(port, 10);
      else body.dir = m.dir;
      await api(`/admin/api/mounts/${m.id}`, { method: "PATCH", body });
      onOpenChange(false);
      await onDone();
      const cleared = !!m.pin && !pin;
      toast.success(cleared ? "PIN removed" : m.pin === pin ? "Share updated" : "PIN updated");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit share</DialogTitle>
          <DialogDescription>
            {m.kind === "port"
              ? "Forwards everything under this address to a local port on this computer."
              : "The address guests open, and the PIN they must enter once."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5">
          <label className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
            Web address
            <Input className="font-mono text-xs" placeholder="/photos" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          {m.kind === "port" && (
            <label className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
              Port on this computer
              <Input
                type="number" min={1024} max={65535}
                className="font-mono text-xs" value={port} onChange={(e) => setPort(e.target.value)}
              />
            </label>
          )}
          <label className="grid gap-1 text-[11.5px] font-medium text-muted-foreground">
            6-digit PIN
            <div className="flex items-center gap-2">
              <Input
                inputMode="numeric" maxLength={6}
                className="font-mono text-xs" placeholder="blank = no PIN"
                value={pin} onChange={(e) => setPin(e.target.value.replace(/[^\d]/g, ""))}
              />
              {m.pin && (
                <Button size="sm" variant="outline" type="button" disabled={busy} onClick={() => setPin("")}>
                  Remove
                </Button>
              )}
            </div>
          </label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Guests type the PIN once — their browser then remembers it for 6 months. Share links copied here include the PIN automatically.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- */
/* Folder picker dialog                                              */
/* ---------------------------------------------------------------- */

const PICKER_KEY = "extranet.lastPicker";

function FolderPickerDialog({
  open, onOpenChange, onUse, recents,
}: { open: boolean; onOpenChange: (o: boolean) => void; onUse: (dir: string) => void; recents: string[] }) {
  const [at, setAt] = useState("");
  const [dirs, setDirs] = useState<{ path: string; name: string }[]>([]);
  const [drives, setDrives] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async (p: string) => {
    try {
      const d = await api<any>(`/admin/api/fs?path=${encodeURIComponent(p)}`);
      setAt(d.path);
      setDirs(d.dirs || []);
      setDrives(!!d.drives);
      setErr("");
      if (d.path) localStorage.setItem(PICKER_KEY, d.path);
    } catch (e: any) {
      setErr(e.message);
      if (p) load(""); // fall back to root
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const last = localStorage.getItem(PICKER_KEY) || "";
    load(last);
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription className="break-all font-mono text-[11.5px]">{at || "This PC"}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="outline" title="Up one level" onClick={() => load(at.replace(/[\\/][^\\/]+$/, "") || "")}>
            ↑
          </Button>
          <div className="flex-1" />
          <Button size="sm" disabled={!at} onClick={() => { onUse(at); onOpenChange(false); }}>Use this folder</Button>
        </div>

        {recents.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Shared before:</span>
            {recents.slice(0, 6).map((d) => (
              <button key={d} title={d} onClick={() => load(d)} className="max-w-52 truncate rounded-md border bg-secondary px-2 py-0.5 font-mono text-[11px] hover:bg-secondary/70">
                {d.split(/[\\/]/).filter(Boolean).pop() || d}
              </button>
            ))}
          </div>
        )}

        <div className="max-h-[46vh] overflow-y-auto rounded-md border">
          {dirs.map((d) => (
            <button
              key={d.path}
              onClick={() => load(d.path)}
              className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-[12.5px] last:border-b-0 hover:bg-accent"
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{d.name}</span>
              <span className="ml-auto truncate font-mono text-[10.5px] text-muted-foreground">{d.path}</span>
            </button>
          ))}
          {!dirs.length && <div className="px-3 py-2 text-[12px] text-muted-foreground">{err || "No subfolders"}</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- */
/* Right rail — internet link                                         */
/* ---------------------------------------------------------------- */

function TunnelCard({ state, refresh, onQR }: { state: State; refresh: () => Promise<any>; onQR: (url: string) => void }) {
  const t = state.tunnel || {};
  const running = t.status === "running" && t.url;

  async function start() {
    toast("Starting the internet link…");
    try {
      const r = await api("/admin/api/tunnel/start", { method: "POST" });
      await refresh();
      if (!r.ok) toast.error(r.error || "Could not start the tunnel");
      else if (r.url) toast.success("Internet link is live");
    } catch (e: any) { toast.error(e.message); }
  }

  async function stop() {
    try { await api("/admin/api/tunnel/stop", { method: "POST" }); await refresh(); } catch (e: any) { toast.error(e.message); }
  }

  async function install() {
    toast("Downloading the Cloudflare helper… (one time)");
    try {
      const r = await api("/admin/api/tunnel/install", { method: "POST" });
      await refresh();
      if (r.ok) toast.success("Ready — start the link when you need it");
      else toast.error(r.error || "Install failed");
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <SectionCard
      icon={<Globe />}
      title="Internet link"
      action={
        <Badge variant={running ? "default" : "secondary"} className="gap-1.5 font-normal">
          <span className={cn("size-1.5 rounded-full", running ? "bg-primary-foreground" : "bg-muted-foreground/40")} />
          {running ? "live" : t.status === "starting" ? "connecting" : "off"}
        </Badge>
      }
    >
      {running && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <a href={`${t.url}/`} target="_blank" rel="noopener" className="block break-all font-mono text-[12px] text-primary underline underline-offset-2">
              {t.url}/
            </a>
            <div className="mt-1 text-[11.5px] text-muted-foreground">Anyone with this link can open internet-marked shares, until you stop it.</div>
          </div>
          <IconBtn title="Copy public link" onClick={() => copyText((t.url || "") + "/").then(() => toast.success("Public link copied"))}><Copy /></IconBtn>
          <IconBtn title="Show QR" onClick={() => onQR(t.url)}><QrCode /></IconBtn>
          <Button size="sm" variant="destructive" onClick={stop}>Stop</Button>
        </div>
      )}
      {t.status === "starting" && (
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          <span className="flex-1 text-[12.5px] text-muted-foreground">Connecting to Cloudflare…</span>
          <Button size="sm" variant="outline" onClick={stop}>Cancel</Button>
        </div>
      )}
      {!running && t.status !== "starting" && !t.installed && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Not set up on this computer</div>
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">
              Downloads a small Cloudflare helper (once). Quick links need no account.
            </div>
          </div>
          <Button size="sm" disabled={t.installing} onClick={install}>
            {t.installing ? <LoaderCircle className="animate-spin" /> : <Download />}
            {t.installing ? (t.installProgress || "downloading…") : "Set up"}
          </Button>
        </div>
      )}
      {!running && t.status !== "starting" && t.installed && t.error && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 text-[12px] text-amber-700">{t.error}</span>
          <Button size="sm" variant="outline" onClick={start}>Try again</Button>
        </div>
      )}
      {!running && t.status !== "starting" && t.installed && !t.error && (
        <div className="px-4 py-3">
          <div className="mb-2 text-[11.5px] text-muted-foreground">Creates a fresh public link for internet-marked shares. Works anywhere, no account needed.</div>
          <Button size="sm" onClick={start}>Start link</Button>
        </div>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------- */
/* Right rail — this network                                         */
/* ---------------------------------------------------------------- */

function NetworkCard({ state, refresh }: { state: State; refresh: () => Promise<any> }) {
  const [httpPort, setHttpPort] = useState(String(state.ports.http));

  useEffect(() => {
    setHttpPort(String(state.ports.http));
  }, [state.ports.http]);

  async function apply() {
    try {
      await api("/admin/api/settings", { method: "PATCH", body: { httpPort: parseInt(httpPort, 10) } });
      toast.success("Settings applied");
      setTimeout(() => refresh(), 2000);
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <SectionCard icon={<Wifi />} title="This network">
      <div>
        {!state.ips.length && <Empty text="No network detected." />}
        {(state.ips || []).map((it: any) => (
          <div key={it.address} className="group flex flex-wrap items-center gap-2 border-b px-4 py-2 last:border-b-0">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[12px]">{it.address}</div>
              <div className="text-[10.5px] text-muted-foreground">{it.name}</div>
            </div>
            <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconBtn title="Copy this address" onClick={() => copyText(it.address).then(() => toast.success("Address copied"))}><Copy /></IconBtn>
              <IconBtn title="Open in browser" asChild>
                <a href={`${baseUrl(state, it.address)}/`} target="_blank" rel="noopener"><ExternalLink /></a>
              </IconBtn>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        <span className="text-[11.5px] text-muted-foreground">Port</span>
        <Input type="number" className="w-20 font-mono text-xs" value={httpPort} onChange={(e) => setHttpPort(e.target.value)} />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={apply}>Apply</Button>
      </div>
      <Note text="Guests on the same Wi-Fi open these links over plain HTTP — no certificate warnings, no setup." />
    </SectionCard>
  );
}

/* ---------------------------------------------------------------- */
/* Bits                                                              */
/* ---------------------------------------------------------------- */

function TokenNote({ state }: { state: State }) {
  if (!state.token) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border bg-card px-4 py-2.5 shadow-sm">
      <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-[11.5px] leading-relaxed text-muted-foreground">
        Admin token <code className="rounded bg-muted px-1 font-mono text-[11px] text-foreground">{state.token}</code> — needed when managing from another device.
      </span>
      <IconBtn title="Copy token" onClick={() => copyText(state.token).then(() => toast.success("Token copied"))}><Copy /></IconBtn>
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 border-t px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="border-b px-4 py-3 text-[12.5px] text-muted-foreground last:border-b-0">{text}</div>;
}
