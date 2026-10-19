import { useCallback, useEffect, useState } from "react";
import {
  Archive, ChevronLeft, ChevronRight, Copy, Download, File, FileText, Film, Folder, ImageIcon,
  Link2, Music, Search, X,
} from "lucide-react";
import { toast } from "sonner";
import { copyText, fmtSize } from "@/lib/api";
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

export default function BrowseApp() {
  const [meta, setMeta] = useState<{ mount: string; dir: string; entries: Entry[] } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [previewIdx, setPreviewIdx] = useState(-1);

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
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-3xl px-5 pb-3 pt-4">
          <nav className="mb-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
            <Crumbs meta={meta} />
          </nav>
          <div className="flex items-center gap-2.5">
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{title}</h1>
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {entries.length
                ? shown.length === entries.length
                  ? `${entries.length} item${entries.length === 1 ? "" : "s"}`
                  : `${shown.length} of ${entries.length}`
                : ""}
            </span>
            <div className="flex-1" />
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
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-28 pt-2">
        {error && (
          <div className="grid place-items-center gap-2 py-20 text-center">
            <File className="size-8 text-muted-foreground/40" />
            <h2 className="text-[15px] font-semibold">Can't open this folder</h2>
            <p className="text-[13px] text-muted-foreground">{error}</p>
          </div>
        )}
        {!error && meta && (
          <>
            {entries.length >= 6 && (
              <div className="relative mt-2 mb-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search this folder"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}
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
            <div className="divide-y">
              {shown.map((e) => <Row key={e.name} e={e} onPreview={() => openPreview(e.name)} />)}
            </div>
          </>
        )}
      </main>

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

function Row({ e, onPreview }: { e: Entry; onPreview: () => void }) {
  const Icon = e.dir ? Folder : CAT_ICON[catOf(e.name)] || File;
  return (
    <div className="group flex items-center gap-3 py-2">
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
