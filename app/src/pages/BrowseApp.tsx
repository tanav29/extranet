import { useCallback, useEffect, useState } from "react";
import {
  Archive, ChevronLeft, ChevronRight, Copy, Download, File, FileText, Film, Folder, ImageIcon,
  LayoutGrid, Link2, List, Music, Search, X,
} from "lucide-react";
import { toast } from "sonner";
import { copyText, fmtSize } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";

/* ---- file categories (kept from the original guest page) ---- */
const CAT: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"],
  video: ["mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv"],
  audio: ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"],
  text: ["txt", "md", "log", "json", "js", "mjs", "ts", "jsx", "tsx", "css", "html", "htm", "xml", "yml", "yaml",
         "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "sh", "ini", "cfg", "toml", "csv", "sql", "php", "lua"],
  archive: ["zip", "gz", "7z", "rar", "tar"],
};
const CAT_ICON: Record<string, any> = { image: ImageIcon, video: Film, audio: Music, text: FileText, archive: Archive, file: File, pdf: File };

function catOf(name: string): string {
  const e = name.split(".").pop()!.toLowerCase();
  for (const [k, list] of Object.entries(CAT)) if (list.includes(e)) return k;
  return "file";
}
const isPdfName = (n: string) => n.split(".").pop()!.toLowerCase() === "pdf";

const seg = (s: string) => encodeURIComponent(s);
const dirUrl = () => location.pathname.replace(/\/?$/, "/");
const fileUrl = (name: string) => dirUrl() + seg(name);
function decodeSafe(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

type Entry = { name: string; dir: boolean; size: number | null; mtime: number | null };

const VIEW_KEY = "extranet.browseView";

export default function BrowseApp() {
  const [meta, setMeta] = useState<{ mount: string; dir: string; entries: Entry[] } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [previewIdx, setPreviewIdx] = useState(-1);
  const [view, setView] = useState<"list" | "grid">(() =>
    localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list");

  const load = useCallback(async () => {
    try {
      const r = await fetch(location.pathname, { headers: { Accept: "application/json" } });
      if (r.status === 404) throw new Error("This item does not exist — it may have been moved or unshared.");
      if (!r.ok) throw new Error("The server said " + r.status + ".");
      const data = await r.json();
      setMeta({ mount: data.mount || "", dir: data.dir || "", entries: data.entries || [] });
    } catch (e: any) {
      setError(e.message || "Can't open this folder");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const entries = meta?.entries || [];
  const files = entries.filter((e) => !e.dir);
  const shown = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
    : entries;
  const shownBytes = shown.reduce((a, e) => a + (e.dir ? 0 : (e.size || 0)), 0);

  function switchView(v: "list" | "grid") {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  }

  function openPreview(name: string) {
    const i = files.findIndex((f) => f.name === name);
    if (i >= 0) setPreviewIdx(i);
  }
  function step(delta: number) {
    if (!files.length) return;
    setPreviewIdx((i) => (i + delta + files.length) % files.length);
  }
  function closePreview() { setPreviewIdx(-1); }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (previewIdx < 0) return;
      if (ev.key === "Escape") closePreview();
      else if (ev.key === "ArrowLeft") step(-1);
      else if (ev.key === "ArrowRight") step(1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewIdx, files.length]);

  useEffect(() => {
    const onPop = () => closePreview();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const parts = (meta?.dir || "").replace(/\/+$/, "").split("/").filter(Boolean);
  const title = parts.length ? decodeSafe(parts[parts.length - 1]) : "Share";
  useEffect(() => { document.title = title + " — shared files"; }, [title]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-5 pb-3 pt-4">
          <nav className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
            <Crumbs meta={meta} />
          </nav>
          <div className="mt-1 flex items-center gap-2.5">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{title}</h1>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {entries.length
                ? shown.length === entries.length
                  ? `${entries.length} item${entries.length === 1 ? "" : "s"}`
                  : `${shown.length} of ${entries.length}`
                : ""}
            </span>
            <div className="flex-1" />
            {entries.length >= 6 && (
              <div className="relative hidden sm:block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 w-48 pl-8 text-xs"
                  placeholder="Search this folder"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}
            <ViewToggle view={view} onChange={switchView} />
            <Button variant="outline" size="icon-sm" title="Copy link to this folder"
              onClick={() => copyText(location.origin + dirUrl()).then(() => toast.success("Link copied"))}>
              <Link2 />
            </Button>
            {entries.some((e) => !e.dir) && (
              <Button size="sm" onClick={() => { location.href = location.pathname + "?zip=1"; }}>
                <Download /> Download all
              </Button>
            )}
          </div>
          {entries.length >= 6 && (
            <div className="relative mt-2 sm:hidden">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder="Search this folder"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-24 pt-4">
        {error && (
          <div className="grid place-items-center gap-2 py-20 text-center">
            <File className="size-8 text-muted-foreground/40" />
            <h2 className="text-[15px] font-semibold">Can't open this folder</h2>
            <p className="text-[13px] text-muted-foreground">{error}</p>
          </div>
        )}
        {!error && meta && (
          <>
            {!entries.length && (
              <div className="grid place-items-center gap-2 py-20 text-center text-muted-foreground">
                <Folder className="size-8 text-muted-foreground/40" />
                <p className="text-[13px]">This folder is empty.</p>
              </div>
            )}
            {entries.length > 0 && !shown.length && (
              <div className="grid place-items-center gap-2 py-20 text-center text-muted-foreground">
                <Search className="size-8 text-muted-foreground/40" />
                <p className="text-[13px]">No matches for “{filter}”.</p>
              </div>
            )}
            {view === "grid"
              ? <GridView shown={shown} onPreview={openPreview} />
              : <ListView shown={shown} onPreview={openPreview} />}
          </>
        )}
      </main>

      {/* reading status bar */}
      {!error && meta && !!entries.length && (
        <footer className="sticky bottom-0 border-t bg-background/90 backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-2 text-[11.5px] text-muted-foreground">
            <span className="tabular-nums">
              {shown.length === entries.length
                ? `${entries.length} items`
                : `${shown.length} of ${entries.length} items`}
              {shownBytes > 0 && <> · {fmtSize(shownBytes)}</>}
            </span>
            <div className="flex-1" />
            <span>files stay on this computer — read-only</span>
          </div>
        </footer>
      )}

      {previewIdx >= 0 && files[previewIdx] && (
        <PreviewDialog
          file={files[previewIdx]}
          onClose={closePreview}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
        />
      )}
    </div>
  );
}

/* ---- view toggle ---- */

function ViewToggle({ view, onChange }: { view: "list" | "grid"; onChange: (v: "list" | "grid") => void }) {
  const opt = (v: "list" | "grid", icon: React.ReactNode, title: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-pressed={view === v}
      onClick={() => onChange(v)}
      className={cn(view === v ? "bg-muted text-foreground" : "text-muted-foreground")}
    >
      {icon}
    </Button>
  );
  return (
    <div className="flex items-center rounded-md border p-0.5">
      {opt("list", <List />, "List view")}
      {opt("grid", <LayoutGrid />, "Grid view")}
    </div>
  );
}

/* ---- list view ---- */

function ListView({ shown, onPreview }: { shown: Entry[]; onPreview: (n: string) => void }) {
  return (
    <div className="divide-y">
      {shown.map((e) => (
        <Row key={e.name} e={e} onPreview={() => onPreview(e.name)} />
      ))}
    </div>
  );
}

function Row({ e, onPreview }: { e: Entry; onPreview: () => void }) {
  const Icon = e.dir ? Folder : CAT_ICON[catOf(e.name)] || File;
  return (
    <div className="group flex items-center gap-3 rounded-md px-2 py-2 -mx-2 hover:bg-accent/50">
      <Icon className={`size-4 shrink-0 ${e.dir ? "text-zinc-500" : "text-muted-foreground"}`} />
      {e.dir ? (
        <a href={dirUrl() + seg(e.name) + "/"} className="min-w-0 flex-1 truncate text-[13.5px] hover:underline">
          {e.name}
        </a>
      ) : (
        <button onClick={onPreview} className="min-w-0 flex-1 truncate text-left text-[13.5px] hover:underline" title={e.name}>
          {e.name}
        </button>
      )}
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{e.dir ? "" : fmtSize(e.size)}</span>
      {!e.dir ? (
        <a
          href={fileUrl(e.name) + "?dl=1"}
          download={e.name}
          title={"Download " + e.name}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Download className="size-4" />
        </a>
      ) : (
        <span className="inline-block size-8 shrink-0" />
      )}
    </div>
  );
}

/* ---- grid view ---- */

function GridView({ shown, onPreview }: { shown: Entry[]; onPreview: (n: string) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5">
      {shown.map((e) => (
        <Tile key={e.name} e={e} onPreview={() => onPreview(e.name)} />
      ))}
    </div>
  );
}

function Tile({ e, onPreview }: { e: Entry; onPreview: () => void }) {
  const Icon = e.dir ? Folder : CAT_ICON[catOf(e.name)] || File;
  const cls = "group relative flex flex-col items-center gap-2 rounded-lg border bg-card p-3 pb-2.5 text-center transition-colors hover:border-ring hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring/70";
  const inner = (
    <>
      <span
        className={cn(
          "grid size-12 place-items-center rounded-lg border bg-muted/40",
          e.dir ? "text-zinc-500" : "text-muted-foreground",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="w-full truncate text-[12.5px] font-medium" title={e.name}>{e.name}</span>
      <span className="text-[10.5px] tabular-nums text-muted-foreground">
        {e.dir ? "folder" : fmtSize(e.size) || "—"}
      </span>
      {!e.dir && (
        <a
          href={fileUrl(e.name) + "?dl=1"}
          download={e.name}
          title={"Download " + e.name}
          onClick={(ev) => ev.stopPropagation()}
          className="absolute right-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Download className="size-3.5" />
        </a>
      )}
    </>
  );
  if (e.dir) {
    return <a href={dirUrl() + seg(e.name) + "/"} className={cls} title={e.name}>{inner}</a>;
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPreview()}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPreview(); } }}
      className={cn(cls, "cursor-pointer")}
      title={e.name}
    >
      {inner}
    </div>
  );
}

/* ---- breadcrumbs ---- */

function Crumbs({ meta }: { meta: { mount: string; dir: string } | null }) {
  if (!meta) return null;
  const mount = (meta.mount || "").replace(/\/+$/, "");
  const dir = (meta.dir || mount || "/").replace(/\/+$/, "");
  if (!mount || !dir.startsWith(mount)) return <>{dir}</>;
  const out: React.ReactNode[] = [];
  const push = (label: string, href: string, here: boolean, key: number) => {
    out.push(
      here ? (
        <span key={key} className="font-medium text-foreground">{label}</span>
      ) : (
        <a key={key} href={href} className="rounded hover:text-foreground">{label}</a>
      )
    );
    if (!here) out.push(<ChevronRight key={"s" + key} className="size-3 opacity-60" />);
  };
  push(mount.slice(1) || "share", mount + "/", dir === mount, 0);
  if (dir !== mount) {
    let acc = mount;
    dir.slice(mount.length + 1).split("/").forEach((part, i) => {
      acc += "/" + part;
      push(decodeSafe(part), acc + "/", acc === dir, i + 1);
    });
  }
  return <>{out}</>;
}

/* ---- preview ---- */

function PreviewDialog({
  file, onClose, onPrev, onNext,
}: { file: Entry; onClose: () => void; onPrev: () => void; onNext: () => void }) {
  const url = fileUrl(file.name);
  const cat = isPdfName(file.name) ? "pdf" : catOf(file.name);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[100dvh] max-w-none flex-col gap-0 rounded-none border-0 p-0 sm:h-[85vh] sm:w-[92vw] sm:max-w-[960px] sm:rounded-lg sm:border"
      >
        <div className="flex items-center gap-1 border-b px-2.5 py-2">
          <Button variant="ghost" size="icon-sm" onClick={onPrev} title="Previous (←)"><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-sm" onClick={onNext} title="Next (→)"><ChevronRight /></Button>
          <div className="min-w-0 flex-1 truncate px-1 text-[13.5px] font-medium">{file.name}</div>
          <div className="shrink-0 pr-1 text-[12px] tabular-nums text-muted-foreground">{fmtSize(file.size)}</div>
          <Button variant="outline" size="sm" asChild>
            <a href={url + "?dl=1"} download={file.name}><Download /> Download</a>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close (Esc)"><X /></Button>
        </div>
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-muted">
          <PreviewMedia cat={cat} url={url} name={file.name} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewMedia({ cat, url, name }: { cat: string; url: string; name: string }) {
  if (cat === "image") return <img src={url} alt={name} className="max-h-full max-w-full" />;
  if (cat === "video") return <video src={url} controls autoPlay preload="metadata" className="max-h-full max-w-full" />;
  if (cat === "audio") return <audio src={url} controls autoPlay className="w-[min(520px,86%)]" />;
  if (cat === "pdf") return <iframe src={url} title={name} className="h-full w-full border-0 bg-white" />;
  if (cat === "text") {
    return <TextPreview url={url} name={name} />;
  }
  return (
    <div className="p-10 text-center text-[13.5px] text-muted-foreground">
      No preview for this file type.<br />Use the download button above.
    </div>
  );
}

function TextPreview({ url, name }: { url: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url).then((r) => r.text()).then((t) => {
      if (!alive) return;
      if (t.length > 2 * 1024 * 1024) t = t.slice(0, 2 * 1024 * 1024) + "\n… (truncated at 2 MB)";
      setText(t);
    }).catch(() => alive && setText("(could not load)"));
    return () => { alive = false; };
  }, [url, name]);
  return (
    <pre className="w-full whitespace-pre-wrap break-words bg-background p-5 font-mono text-[12.5px] leading-relaxed">
      {text ?? "Loading…"}
    </pre>
  );
}
