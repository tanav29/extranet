/* Adapter for T3's Vite/TanStack browser build. Keep route definitions and
 * arbitrary strings intact: only the router options and Vite preload helper
 * are changed. Tests pin these signatures so upstream changes are visible. */
export function rewriteT3Script(source: string, prefix: string) {
  return source
    .replace(/\{routeTree:([\w$]+),history:/g, `{basepath:${JSON.stringify(prefix)},routeTree:$1,history:`)
    .replace(/return`\/`\+([\w$]+)/g, `return ${JSON.stringify(prefix + '/')}+$1`);
}

export function t3Bootstrap(prefix: string) {
  return `(${install.toString()})(${JSON.stringify(prefix)});`;
}

// Serialized and served before T3's own scripts; must have no module references.
function install(prefix: string) {
  const NativeURL = window.URL;
  const map = (value: string | URL) => {
    const url = new NativeURL(String(value), location.href);
    const same = url.host === location.host && ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
    if (same && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname;
    return url.href;
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (input instanceof Request) {
      const url = map(input.url);
      return nativeFetch(url === input.url ? input : new Request(url, input), init);
    }
    return nativeFetch(map(input), init);
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(map(url), protocols);
    }
  };
  const NativeEvents = window.EventSource;
  window.EventSource = class extends NativeEvents {
    constructor(url: string | URL, options?: EventSourceInit) { super(map(url), options); }
  };
}
