import type { ChildProcess } from 'node:child_process';

export type ServiceName = 'web' | 'api' | 'files' | 'proxy';
export type ClientKind = 'local' | 'lan' | 'tunnel';

export interface VisitorContext {
  kind: ClientKind;
  local: boolean;
  isTunnel: boolean;
  ip: string;
}

export interface Share {
  id: string;
  kind: 'folder' | 'port';
  path: string;
  dir?: string;
  port?: number | null;
  upstreamPath?: 'strip' | 'preserve';
  adapter?: 'native' | 't3';
  entryPath?: string;
  pin?: string | null;
  lan: boolean;
  public: boolean;
}

export interface Config {
  proxyPort: number;
  adminToken: string;
  routes: Share[];
  recentDirs: string[];
  blockedIPs: { ip: string; ts: number; note?: string }[];
}

export type Runtime = Partial<Record<ServiceName, number>> & {
  runId?: string;
  ts?: number;
  services?: Partial<Record<ServiceName, { pid: number; port: number }>>;
};

export interface AccessEvent {
  t: number;
  ip: string;
  kind: ClientKind;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string;
  share?: string;
  blocked?: boolean;
}

export interface ClientStats {
  count: number;
  bytes: number;
  first: number;
  last: number;
  ua: string;
  lan: boolean;
  tunnel: boolean;
}

export interface AccessLog {
  entries: AccessEvent[];
  ips: Record<string, ClientStats>;
}

export interface Battery {
  present: boolean;
  level: number;
  charging: boolean;
  ac: boolean;
}

export interface Tunnel {
  proc: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'stopping';
  url: string | null;
  error: string | null;
  log: string[];
  installing: boolean;
  installProgress: string;
  binPath: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: VisitorContext;
  }
}
