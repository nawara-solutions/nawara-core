import { createServer, type Server } from 'node:http';

export interface FakeAuthServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * A minimal stand-in for auth-service's `GET /auth/me` — the only endpoint `HttpAuthClient` (libs/service-kit)
 * calls — so a real-broker suite can drive a payer-authenticated request through Payment's real `ServiceOrUserGuard`
 * without running a real auth-service process. Payment-service's production code and wire contract are exercised
 * completely unmodified: only the identity behind a small, fixed set of bearer tokens is test-controlled, exactly as
 * a real auth-service would answer for those tokens.
 */
export function startFakeAuthServer(identities: Record<string, { id: string; isActive: boolean }>): Promise<FakeAuthServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const header = req.headers.authorization;
      const token = typeof header === 'string' ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
      const identity = token ? identities[token] : undefined;
      if (req.url === '/auth/me' && identity) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: identity.id, isActive: identity.isActive, adminTier: null, memberships: [] }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
