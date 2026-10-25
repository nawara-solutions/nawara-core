import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Identity = { userId: string; kind: 'owner' | 'operator' | 'member'; companyId: string | null; isActive?: boolean };
export type Mode = 'ok' | 'hang' | 'down' | 'reset' | 'redirect' | 'no_content' | 'empty' | 'oversized' | 'slow_body' | 'bad_kind' | 'wrong_platform';

/**
 * Core V2 S3d: a stub of exactly Auth's two approved routes the Platform configuration asks: `GET /auth/grants` (the caller's live facts;
 * 401 for an unknown or revoked bearer) and `GET /auth/platform-access/:platformId` (200 `{platformId, allowed: true}` when an Owner's
 * Company owns the Platform, otherwise Auth's collapsed 404; 400 for a non-uuid). `mode` breaks one route (`target`) in a named way.
 * It also answers `GET /auth/me` (the live identity the kit's `HttpAuthClient` reads for user-token routes; `mode: 'down'` with
 * `target: 'me'` breaks it).
 * Every request is recorded, so tests prove what Billing sends to Auth.
 */
export class FakeAuth {
  mode: Mode = 'ok';
  target: 'grants' | 'access' | 'me' = 'grants';
  readonly identities = new Map<string, Identity>();
  /** platformId -> companyId, as Auth knows it now. */
  readonly platforms = new Map<string, string>();
  readonly received: Array<{ path: string; authorization: string | undefined }> = [];
  readonly sinkReceived: string[] = [];
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

  reset(): void {
    this.mode = 'ok';
    this.target = 'grants';
    this.received.length = 0;
    this.sinkReceived.length = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for await (const _ of req) { /* drain */ }
    this.received.push({ path: req.url ?? '', authorization: req.headers.authorization });
    const send = (status: number, b?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b));
    };
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = this.identities.get(bearer);
    const route = req.url === '/auth/grants' ? 'grants' : req.url === '/auth/me' ? 'me' : req.url?.startsWith('/auth/platform-access/') ? 'access' : null;
    if (route === null) return send(404, { message: 'Not Found' });
    if (route === this.target) {
      if (this.mode === 'hang') return;
      if (this.mode === 'down') return send(500, { message: 'Internal Server Error' });
      if (this.mode === 'reset') return void req.socket.destroy();
      if (this.mode === 'redirect') {
        res.writeHead(307, { location: `http://127.0.0.1:${(this.sink.address() as AddressInfo).port}${req.url}` });
        return void res.end();
      }
      if (this.mode === 'no_content') return send(204);
      if (this.mode === 'empty') return send(200, {});
      if (this.mode === 'slow_body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.write('{"userId":');
      }
      if (this.mode === 'oversized') return send(200, { padding: 'x'.repeat(20_000) });
    }
    if (!who) return send(401, { message: 'Unauthorized' });
    if (route === 'me') return send(200, { id: who.userId, adminTier: who.kind === 'member' ? null : who.kind, isActive: who.isActive ?? true, memberships: [] });
    if (route === 'grants') {
      if (this.mode === 'bad_kind' && this.target === 'grants') return send(200, { ...who, kind: 'superuser', platformAssignments: [], organizationAdminMemberships: [] });
      return send(200, { userId: who.userId, kind: who.kind, ...(who.kind === 'owner' ? { companyId: who.companyId } : {}), platformAssignments: [], organizationAdminMemberships: [] });
    }
    const platformId = decodeURIComponent(req.url!.slice('/auth/platform-access/'.length));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(platformId)) return send(400, { message: 'Validation failed (uuid is expected)' });
    if (who.kind === 'member') return send(403, { message: 'Forbidden' });
    const company = this.platforms.get(platformId.toLowerCase());
    if (!company || who.kind !== 'owner' || company !== who.companyId?.toLowerCase()) return send(404, { message: 'Not Found' });
    if (this.mode === 'wrong_platform' && this.target === 'access') return send(200, { platformId: '00000000-0000-4000-8000-000000000000', allowed: true });
    return send(200, { platformId, allowed: true });
  }
}
