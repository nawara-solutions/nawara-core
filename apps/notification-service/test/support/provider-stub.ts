import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A local HTTP stand-in for a provider API (Stage 16.8 contract tests): no real provider is ever called. Each request is recorded (in
 * test memory only) and answered by the current behaviour.
 */
export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export type StubBehaviour =
  | { kind: 'json'; status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
  | { kind: 'raw'; status: number; body: string; headers?: Record<string, string> }
  /** Read the request, then never answer. */
  | { kind: 'hang' }
  /** Read the request, then destroy the socket: the provider may have acted on it. */
  | { kind: 'reset' };

export class ProviderStub {
  readonly requests: StubRequest[] = [];
  behaviour: StubBehaviour | ((req: StubRequest, n: number) => StubBehaviour) = { kind: 'json', status: 200, body: {} };
  /** Sockets closed by the CLIENT while a request was pending (an abort reached the network). */
  clientAborts = 0;
  /** Requests being handled right now, and the most at once. */
  inFlight = 0;
  maxInFlight = 0;
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  get openSockets(): number {
    return this.sockets.size;
  }

  reset(): void {
    this.requests.length = 0;
    this.clientAborts = 0;
    this.maxInFlight = this.inFlight;
    this.behaviour = { kind: 'json', status: 200, body: {} };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    res.on('close', () => this.inFlight--);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r: StubRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    this.requests.push(r);
    const b = typeof this.behaviour === 'function' ? this.behaviour(r, this.requests.length) : this.behaviour;
    let answered = false;
    res.on('close', () => {
      if (!answered && b.kind === 'hang') this.clientAborts++;
    });
    if (b.kind === 'hang') return;
    if (b.kind === 'reset') {
      req.socket.destroy();
      return;
    }
    if (b.kind === 'json' && b.delayMs) await new Promise((t) => setTimeout(t, b.delayMs));
    answered = true;
    const body = b.kind === 'raw' ? b.body : b.body === undefined ? '' : JSON.stringify(b.body);
    res.writeHead(b.status, { 'content-type': 'application/json', ...b.headers });
    res.end(body);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }
}

/** A port nothing listens on (bound, then released): connection refused, the request is never sent. */
export async function closedPortUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
