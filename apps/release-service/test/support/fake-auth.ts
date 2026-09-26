import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Identity = { userId: string; kind: 'owner' | 'operator' | 'member'; companyId: string | null };
export type Mode = 'ok' | 'hang' | 'down' | 'reset' | 'redirect' | 'no_content' | 'empty' | 'oversized' | 'slow_body' | 'bad_kind' | 'hang_step_up' | 'down_step_up' | 'slow_grants_hang_step_up';

/**
 * A stub of exactly Auth's contract for Stage 20.4: `GET /auth/grants` (the caller's live facts, 401 for an unknown / revoked bearer) and
 * `POST /auth/step-up/verify` (204 when the proof exists, belongs to THIS bearer's session, was issued for THIS purpose, is unexpired and
 * unconsumed — and consumes it; 403 otherwise). It records every request, so tests prove what release-service sends to Auth.
 */
export class FakeAuth {
  mode: Mode = 'ok';
  readonly identities = new Map<string, Identity>();
  readonly received: Array<{ method: string; path: string; authorization: string | undefined; body: string }> = [];
  readonly sinkReceived: string[] = [];
  private readonly proofs = new Map<string, { bearer: string; purpose: string; expiresAt: number; consumedAt: number | null }>();
  private server!: Server;
  private sink!: Server;
  url = '';

  async start(): Promise<void> {
    this.sink = createServer((req, res) => {
      this.sinkReceived.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => this.sink.listen(0, '127.0.0.1', r));
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    this.sink.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
    await new Promise<void>((r) => this.sink.close(() => r()));
  }

  /** Issues a step-up proof, as POST /auth/admin/step-up would after a TOTP / passkey: bound to this bearer's session and this purpose. */
  issue(bearer: string, purpose: string, ttlMs = 300_000): string {
    const id = randomUUID();
    this.proofs.set(id, { bearer, purpose, expiresAt: Date.now() + ttlMs, consumedAt: null });
    return id;
  }

  consumed(proof: string): boolean {
    return this.proofs.get(proof)?.consumedAt != null;
  }

  requests(path: string): number {
    return this.received.filter((r) => r.path === path).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const c of req) body += String(c);
    this.received.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body });
    const send = (status: number, b?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b));
    };
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = this.identities.get(bearer);
    if (req.url === '/auth/grants') {
      if (this.mode === 'slow_grants_hang_step_up') await new Promise((r) => setTimeout(r, 500));
      if (this.mode === 'hang') return;
      if (this.mode === 'down') return send(500, { message: 'Internal Server Error' });
      if (this.mode === 'reset') return void req.socket.destroy();
      if (this.mode === 'redirect') {
        res.writeHead(307, { location: `http://127.0.0.1:${(this.sink.address() as AddressInfo).port}/auth/grants` });
        return void res.end();
      }
      if (this.mode === 'no_content') return send(204);
      if (this.mode === 'empty') return send(200, {});
      if (this.mode === 'slow_body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.write('{"userId":');
      }
      if (!who) return send(401, { message: 'Unauthorized' });
      if (this.mode === 'bad_kind') return send(200, { ...who, kind: 'superuser', platformAssignments: [], organizationAdminMemberships: [] });
      const facts = { ...who, platformAssignments: [], organizationAdminMemberships: [] };
      if (this.mode === 'oversized') return send(200, { ...facts, padding: 'x'.repeat(20_000) });
      return send(200, facts);
    }
    if (req.url === '/auth/step-up/verify' && req.method === 'POST') {
      if (this.mode === 'hang_step_up' || this.mode === 'slow_grants_hang_step_up') return;
      if (this.mode === 'down_step_up') return send(502, { message: 'Bad Gateway' });
      if (!who) return send(401, { message: 'Unauthorized' });
      let dto: { purpose?: string; stepUpToken?: string };
      try {
        dto = JSON.parse(body) as typeof dto;
      } catch {
        return send(400, { message: 'Bad Request' });
      }
      const p = this.proofs.get(dto.stepUpToken ?? '');
      if (!p || p.bearer !== bearer || p.purpose !== dto.purpose || p.consumedAt !== null || p.expiresAt <= Date.now()) return send(403, { code: 'step_up_required' });
      p.consumedAt = Date.now();
      return send(204);
    }
    return send(404, { message: 'Not Found' });
  }
}
