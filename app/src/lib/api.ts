const TOKEN_KEY = "extranet.token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(
  pathname: string,
  opts: Omit<RequestInit, "body"> & { body?: unknown } = {}
): Promise<T> {
  const headers = new Headers(opts.headers as HeadersInit | undefined);
  headers.set("Authorization", "Bearer " + getToken());
  const { body, ...rest } = opts;
  let bodyInit: BodyInit | undefined;
  if (body !== undefined && typeof body !== "string") {
    bodyInit = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  } else if (typeof body === "string") {
    bodyInit = body;
  }
  const r = await fetch(pathname, { ...rest, body: bodyInit, headers });
  if (r.status === 401) throw new ApiError("token needed", 401);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((data as any).error || "error " + r.status, r.status);
  return data as T;
}

export function escapeHTML(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

export function fmtSize(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

export function fmtBytes(n: number): string {
  return fmtSize(n) || "0 B";
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (sameDay) return time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 15000) return "just now";
  if (diff < 60000) return Math.round(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.round(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + "h ago";
  return Math.round(diff / 86400000) + "d ago";
}

export function deviceOf(ua: string | undefined): string {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (/iphone/.test(s)) return "iPhone";
  if (/ipad/.test(s)) return "iPad";
  if (/android/.test(s)) return /mobile/.test(s) ? "Android phone" : "Android";
  if (/windows/.test(s)) return "Windows";
  if (/macintosh|mac os/.test(s)) return "Mac";
  if (/cros/.test(s)) return "Chromebook";
  if (/linux/.test(s)) return "Linux";
  if (/bot|crawler|spider/.test(s)) return "Bot";
  return "Other";
}

export function primaryIP(state: any): string | null {
  return (state.ips && state.ips[0] && state.ips[0].address) || null;
}

export function baseUrl(state: any, ip: string | null): string {
  const port = (state?.ports?.http) || 5050;
  if (!ip) return `http://localhost:${port}`;
  return `http://${ip}:${port}`;
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* noop */ }
    ta.remove();
  });
}
