import { useCallback, useEffect, useState } from "react";
import {
  Activity, Ban, BarChart3, Clock, Download, Globe, HardDrive, LoaderCircle,
  Monitor, RefreshCw, Search, ShieldBan, Trash2, Users,
} from "lucide-react";
import { toast } from "sonner";
import { api, deviceOf, fmtBytes, fmtTime, relTime } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AppShell, Gate, SectionCard } from "@/components/shared";

type Entry = {
  t: number; ip: string; method: string; path: string; status: number;
  bytes: number; ua: string; share: string | null; kind: string; blocked: boolean;
};

type Client = {
  ip: string; count: number; bytes: number; first: number; last: number;
  ua: string; lan: boolean; tunnel: boolean; blocked: boolean;
};

type Analytics = { entries: Entry[]; ips: Client[]; blocked: { ip: string; ts: number; note?: string }[]; kept: number };

const KIND_ICON: Record<string, any> = { tunnel: Globe, lan: Monitor, local: HardDrive };

export default function AnalyticsApp() {
  const [data, setData] = useState<Analytics | null>(null);
  const [host, setHost] = useState("");
  const [needToken, setNeedToken] = useState(false);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      const d = await api<Analytics>("/api/analytics?limit=300");
      setData(d);
    } catch (e: any) {
      if (e.status === 401) setNeedToken(true);
      // polling errors are quiet; the manual button reports them
      else if (!auto) toast.error(e.message);
    }
  }, [auto]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    api("/api/state").then((s: any) => setHost(s.hostname)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!auto) return;
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refresh();
    }, 5000);
    return () => clearInterval(iv);
  }, [auto, refresh]);

  if (needToken) return <Gate onDone={() => refresh()} />;

  async function clearLogs() {
    if (!confirm("Clear all logged requests and client stats? Blocked addresses stay blocked.")) return;
    try {
      await api("/api/logs/clear", { method: "POST" });
      toast.success("Logs cleared");
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  async function setBlocked(ip: string, block: boolean) {
    try {
      await api("/api/block", { method: "POST", body: { ip, block } });
      toast.success(block ? `Blocked ${ip}` : `Unblocked ${ip}`);
      refresh();
    } catch (e: any) { toast.error(e.message); }
  }

  const entries = (data?.entries || []).filter((e) => {
    if (!filter.trim()) return true;
    const f = filter.trim().toLowerCase();
    return e.path.toLowerCase().includes(f) || e.ip.toLowerCase().includes(f);
  });
  const totals = {
    requests: data?.entries.length || 0,
    clients: data?.ips.length || 0,
    bytes: (data?.ips || []).reduce((a, c) => a + (c.bytes || 0), 0),
    blockedHits: (data?.entries || []).filter((e) => e.blocked).length,
  };

  return (
    <AppShell page="analytics" host={host || undefined}>
      <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-5 py-5 xl:px-8 max-lg:pb-24">
        {/* header row */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="flex items-center gap-2 text-[15.5px] font-semibold tracking-tight">
              <BarChart3 className="size-4" /> Analytics
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Who opened your shares, what they took, and who to keep out.
            </p>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <Switch checked={auto} onCheckedChange={setAuto} /> live
          </label>
          <Button size="sm" variant="outline" onClick={() => refresh()}><RefreshCw /> Refresh</Button>
          <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={clearLogs}><Trash2 /> Clear</Button>
        </div>

        {!data ? (
          <div className="grid flex-1 place-items-center text-muted-foreground"><LoaderCircle className="size-5 animate-spin" /></div>
        ) : (
          <>
            {/* facts */}
            <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat icon={<Activity />} label={`Requests (of ${data.kept})`} value={String(totals.requests)} />
              <Stat icon={<Users />} label="Clients seen" value={String(totals.clients)} />
              <Stat icon={<Download />} label="Data served" value={fmtBytes(totals.bytes)} />
              <Stat icon={<ShieldBan />} label="Blocked hits" value={String(totals.blockedHits)} tone={totals.blockedHits ? "warn" : undefined} />
            </div>

            {/* two panes: the log on the left, people on the right */}
            <div className="grid min-h-0 flex-1 grid-cols-1 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_370px] max-lg:items-start">
              <SectionCard
                icon={<Activity />}
                title="Request log"
                className="flex min-h-0 flex-col"
                action={
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 w-48 pl-8 text-xs"
                      placeholder="Filter by path or IP"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </div>
                }
              >
                <div className="min-h-0 max-h-[46vh] flex-1 overflow-y-auto lg:max-h-none">
                  <LogsTable entries={entries} />
                </div>
              </SectionCard>

              <div className="grid min-h-0 grid-cols-1 gap-4">
                <SectionCard icon={<Users />} title="Clients" className="flex min-h-0 flex-col" bodyClass="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 max-h-[46vh] flex-1 overflow-y-auto lg:max-h-none">
                    <ClientsTable ips={data.ips} localIPs={["127.0.0.1", "::1"]} onBlock={setBlocked} />
                  </div>
                </SectionCard>
                <SectionCard icon={<ShieldBan />} title={`Blocked${data.blocked.length ? ` (${data.blocked.length})` : ""}`}>
                  <div className="max-h-40 overflow-y-auto">
                    <BlockedTable blocked={data.blocked} onUnblock={setBlocked} />
                  </div>
                </SectionCard>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="[&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums tracking-tight ${tone === "warn" ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  const tone =
    status >= 500 ? "bg-red-100 text-red-800 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30" :
    status >= 400 ? "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30" :
    status >= 300 ? "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-500/15 dark:text-zinc-300 dark:border-zinc-500/30" :
    "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30";
  return (
    <Badge variant="outline" className={`h-5 w-12 justify-center border px-1 font-mono text-[10.5px] ${tone}`}>
      {status}
    </Badge>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] || Monitor;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LogsTable({ entries }: { entries: Entry[] }) {
  if (!entries.length) {
    return <EmptyLog text="No requests yet. Guests' visits to your shares show up here." />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Time</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Method</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Size</TableHead>
          <TableHead className="pr-4"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e, i) => (
          <TableRow key={i} className={e.blocked ? "bg-red-50/50 dark:bg-red-500/10" : undefined}>
            <TableCell className="pl-4 font-mono text-[11px] text-muted-foreground">
              <span title={fmtTime(e.t)}>{fmtClock(e.t)}</span>
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5 font-mono text-[12px]">
                <KindIcon kind={e.kind} />
                {e.ip}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="justify-center font-mono text-[10px]">{e.method}</Badge>
            </TableCell>
            <TableCell className="max-w-[300px]">
              <span className="block truncate font-mono text-[12px]" title={e.path}>{e.path}</span>
            </TableCell>
            <TableCell><div className="flex items-center gap-1.5"><StatusBadge status={e.status} />{e.blocked && <Badge className="bg-red-600 text-[10px]">blocked</Badge>}</div></TableCell>
            <TableCell className="text-right font-mono text-[11px] text-muted-foreground">{e.bytes ? fmtBytes(e.bytes) : ""}</TableCell>
            <TableCell className="pr-4 text-right">
              {e.share && <Badge variant="secondary" className="font-mono text-[10px]">{e.share}</Badge>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ClientsTable({ ips, localIPs, onBlock }: { ips: Client[]; localIPs: string[]; onBlock: (ip: string, block: boolean) => void }) {
  if (!ips.length) return <EmptyLog text="No clients yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Address</TableHead>
          <TableHead>Device</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Data</TableHead>
          <TableHead>Last seen</TableHead>
          <TableHead className="pr-4 text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ips.map((c) => {
          const local = localIPs.includes(c.ip);
          return (
            <TableRow key={c.ip}>
              <TableCell className="pl-4">
                <div className="flex items-center gap-1.5">
                  <KindIcon kind={c.tunnel && !c.lan ? "tunnel" : c.lan ? "lan" : "lan"} />
                  <span className="font-mono text-[12px]">{c.ip}</span>
                  {local && <Badge variant="secondary" className="text-[10px]">this computer</Badge>}
                  {c.blocked && <Badge className="bg-red-600 text-[10px]">blocked</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-[12px] text-muted-foreground"><span title={c.ua}>{deviceOf(c.ua)}</span></TableCell>
              <TableCell className="text-right font-mono text-[12px] tabular-nums">{c.count}</TableCell>
              <TableCell className="text-right font-mono text-[11px] text-muted-foreground">{c.bytes ? fmtBytes(c.bytes) : ""}</TableCell>
              <TableCell className="text-[12px] text-muted-foreground" title={fmtTime(c.last)}>{relTime(c.last)}</TableCell>
              <TableCell className="pr-4 text-right">
                {local ? (
                  <span className="text-[11px] text-muted-foreground">—</span>
                ) : c.blocked ? (
                  <Button size="sm" variant="outline" onClick={() => onBlock(c.ip, false)}>Unblock</Button>
                ) : (
                  <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => onBlock(c.ip, true)}>
                    <Ban /> Block
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function BlockedTable({ blocked, onUnblock }: { blocked: { ip: string; ts: number; note?: string }[]; onUnblock: (ip: string, block: boolean) => void }) {
  if (!blocked.length) return <EmptyLog text="Nobody is blocked. Block a client from the Clients pane and their requests get rejected hereafter." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Address</TableHead>
          <TableHead>Blocked since</TableHead>
          <TableHead className="pr-4 text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blocked.map((b) => (
          <TableRow key={b.ip}>
            <TableCell className="pl-4">
              <span className="flex items-center gap-1.5 font-mono text-[12px]">
                <ShieldBan className="size-3.5 text-destructive" />
                {b.ip}
              </span>
            </TableCell>
            <TableCell className="text-[12px] text-muted-foreground" title={fmtTime(b.ts)}><span className="flex items-center gap-1.5"><Clock className="size-3.5" />{relTime(b.ts)}</span></TableCell>
            <TableCell className="pr-4 text-right">
              <Button size="sm" variant="outline" onClick={() => onUnblock(b.ip, false)}>Unblock</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function EmptyLog({ text }: { text: string }) {
  return (
    <div className="grid place-items-center gap-2 px-4 py-14 text-center">
      <Activity className="size-6 text-muted-foreground/40" />
      <p className="max-w-xs text-[12.5px] text-muted-foreground">{text}</p>
    </div>
  );
}
