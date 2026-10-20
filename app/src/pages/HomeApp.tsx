import { useCallback, useEffect, useState } from "react";
import {
  AppWindow, ArrowUpRight, Battery, BatteryCharging, BatteryFull, Folder,
  Globe, Link2, LoaderCircle, Lock, Monitor, Wifi, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/shared";
import { cn } from "@/lib/utils";

type Share = {
  path: string;
  kind: "folder" | "app" | "link";
  pin: boolean;
  dir?: string | null;
  port?: number | null;
  url?: string | null;
  scope?: "lan" | "internet" | "both";
};

type Sys = {
  name: string;
  platform: "windows" | "mac" | "linux";
  battery: { present: boolean; level?: number; charging?: boolean; ac?: boolean } | null;
  internet: boolean | null;
  connection: { name: string; address: string } | null;
  shares: Share[];
  local?: boolean;
  tunnelLive?: boolean;
};

const PLATFORM_LABEL: Record<string, string> = { windows: "Windows PC", mac: "Mac", linux: "Linux" };
const SCOPE_LABEL: Record<string, { text: string }> = {
  lan: { text: "Wi-Fi" },
  internet: { text: "Internet" },
  both: { text: "Wi-Fi + Internet" },
};

/* small bordered badge, same austerity as the browse page */
const badgeCls =
  "inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground [&_svg]:size-3";

export default function HomeApp() {
  const [info, setInfo] = useState<Sys | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(location.pathname + "?json=1", { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("The server said " + r.status + ".");
      setInfo(await r.json());
      setError("");
    } catch (e: any) {
      setError(e.message || "Can't reach the server");
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const iv = setInterval(() => {
      // keep the chips alive (battery walks, link comes up) but quietly
      if (document.visibilityState === "visible") load();
    }, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const name = info?.name || "";
  useEffect(() => { document.title = name ? `${name} — shared files` : "Extranet"; }, [name]);

  if (!error && !info) {
    return (
      <div className="grid min-h-dvh place-items-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-12 pt-10 sm:pt-14">
        {error && <ErrorBox msg={error} onRetry={load} />}
        {!error && info && (
          <>
            <Hero info={info} />
            <SharesSection info={info} />
          </>
        )}
      </main>

      <footer className="border-t bg-background/90">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-2.5 text-[11.5px] text-muted-foreground">
          <span>files stay on the host — read-only</span>
          <div className="flex-1" />
          {name && <span>Extranet on {name}</span>}
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: Hi! + who you're connected to + the live status chips          */
/* ------------------------------------------------------------------ */

function Hero({ info }: { info: Sys }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <Link2 className="size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Hi 👋</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Welcome to <span className="font-semibold text-foreground">{info.name}</span> —
            every path this computer shares with you is listed below.
          </p>
        </div>
        {info.local && (
          <Button variant="outline" size="sm" className="ml-auto" asChild>
            <a href="/admin">Admin console</a>
          </Button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <BatteryChip b={info.battery} />
        <ConnectionChip c={info.connection} />
        {info.internet !== null && (
          <StatusChip icon={<Globe />} tone={info.internet ? undefined : "warn"}>
            {info.internet ? "Internet reachable" : "No internet — shares are Wi-Fi only"}
          </StatusChip>
        )}
        <StatusChip icon={<Monitor />}>{PLATFORM_LABEL[info.platform] || info.platform}</StatusChip>
        <StatusChip icon={<Folder />}>{info.shares.length === 1 ? "1 share" : `${info.shares.length} shares`}</StatusChip>
        {info.local && info.tunnelLive && <StatusChip icon={<Globe />}>Internet link live</StatusChip>}
      </div>
    </div>
  );
}

function BatteryChip({ b }: { b: Sys["battery"] }) {
  if (!b?.present) return null;
  const level = b.level ?? 0;
  const full = (b.ac || b.charging) && level >= 100;
  const icon = full ? <BatteryFull /> : b.charging ? <BatteryCharging /> : <Battery />;
  const text = full ? "Battery full" : b.charging ? `${level}% · charging` : `${level}%`;
  return <StatusChip icon={icon}>{text}</StatusChip>;
}

function ConnectionChip({ c }: { c: Sys["connection"] }) {
  if (!c) return <StatusChip tone="warn" icon={<WifiOff />}>No LAN address</StatusChip>;
  return <StatusChip icon={<Wifi />}>{c.name} · {c.address}</StatusChip>;
}

/* ------------------------------------------------------------------ */
/* The directory itself                                                */
/* ------------------------------------------------------------------ */

function SharesSection({ info }: { info: Sys }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2.5">
        <h2 className="text-[13.5px] font-semibold">Shared on this computer</h2>
        <span className="text-[11.5px] tabular-nums text-muted-foreground">
          {info.shares.length === 1 ? "1 path" : `${info.shares.length} paths`}
        </span>
      </div>

      {info.shares.length ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {info.shares.map((s) => <ShareCard key={s.path} s={s} local={info.local} />)}
        </div>
      ) : (
        <EmptyState local={info.local} />
      )}
    </section>
  );
}

function ShareCard({ s, local }: { s: Share; local?: boolean }) {
  const badge =
    "grid size-10 shrink-0 place-items-center rounded-lg border bg-muted/40 text-zinc-500";
  const scope = local && s.scope ? SCOPE_LABEL[s.scope] : null;
  return (
    <a
      href={`${s.path.replace(/\/+$/, "")}/`}
      className="group relative flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-ring hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring/70"
    >
      <span className={badge}>
        {s.kind === "app" ? <AppWindow className="size-5" /> : s.kind === "link" ? <Link2 className="size-5" /> : <Folder className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[13.5px] font-medium">{s.path}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={badgeCls}>{s.kind === "app" ? "app" : s.kind === "link" ? "link" : "folder"}</span>
          {s.pin && <span className={badgeCls}><Lock /> PIN</span>}
          {scope && (
            <span className={badgeCls}>
              {s.scope === "internet" || s.scope === "both" ? <Globe /> : <Wifi />}
              {scope.text}
            </span>
          )}
        </div>
        {local && !!(s.dir || s.port || s.url) && (
          <div className="mt-1 truncate text-[11px] text-muted-foreground" title={s.dir ? `${s.dir}` : s.url ? `${s.url}` : `port ${s.port}`}>
            {s.dir ? s.dir : s.url ? s.url : `→ 127.0.0.1:${s.port}`}
          </div>
        )}
      </div>
      <ArrowUpRight className="size-4 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  );
}

function EmptyState({ local }: { local?: boolean }) {
  return (
    <div className="grid place-items-center gap-3 rounded-xl border border-dashed bg-card/50 px-6 py-16 text-center">
      <Folder className="size-8 text-muted-foreground/40" />
      <p className="text-[13px] text-muted-foreground">
        Nothing is shared right now.
        {local && <> Add a folder or app from the admin console — it only takes a click.</>}
      </p>
      {local && (
        <Button size="sm" asChild>
          <a href="/admin">Open admin console</a>
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ErrorBox({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className={cn("grid place-items-center gap-3 rounded-xl border bg-card px-6 py-16 text-center")}>
      <Link2 className="size-8 text-muted-foreground/40" />
      <h2 className="text-[15px] font-semibold">Can't reach this computer</h2>
      <p className="text-[13px] text-muted-foreground">{msg}</p>
      <Button size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}
