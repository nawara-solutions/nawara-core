import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpAuthGrantsClient } from './auth-grants-client.js';

/**
 * Stage 10.1 audit follow-up (MEDIUM): the real HTTP wire contract of `HttpAuthGrantsClient` against
 * Auth's `/auth/grants` and `/auth/step-up/verify` was previously only exercised through a hand-rolled
 * fake (`FakeAuthGrantsClient` in `test/admin.e2e-spec.ts`), so a field rename or shape drift in Auth's
 * real response would not have been caught. This spec drives the REAL client class — real `fetch`, real
 * JSON serialization on the way out, real deserialization on the way in — against a local HTTP server
 * this file fully controls, so it can assert both the exact request the client sends and prove the
 * client rejects a response whose shape has drifted from what it expects.
 *
 * A second, independent proof of the POSITIVE contract (the real client talking to the REAL Auth
 * process, not a stand-in server) lives in `test/e2e-auth-organization` (two live spawned processes,
 * real HTTP, real database) — this file's job is the fast, isolated shape/negative coverage that suite
 * cannot cheaply provide (Auth's real endpoint cannot be made to return a malformed response on demand).
 */
describe('HttpAuthGrantsClient wire contract', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string } | undefined;
  let respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.writeHead(404).end();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastRequest = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('expected a bound TCP address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    lastRequest = undefined;
    respond = (_req, res) => res.writeHead(404).end();
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const WELL_FORMED = { userId: 'u-1', kind: 'owner', companyId: 'co-1', platformAssignments: [], organizationAdminMemberships: [] };

  describe('grantsFor', () => {
    it("sends a GET to /auth/grants with the caller's bearer forwarded as Authorization, no body", async () => {
      respond = (_req, res) => json(res, 200, WELL_FORMED);
      const client = new HttpAuthGrantsClient({ baseUrl });
      await client.grantsFor('the-users-own-bearer');
      expect(lastRequest?.method).toBe('GET');
      expect(lastRequest?.url).toBe('/auth/grants');
      expect(lastRequest?.headers.authorization).toBe('Bearer the-users-own-bearer');
      expect(lastRequest?.body).toBe('');
    });

    it('parses a well-formed response into the exact GrantFacts shape', async () => {
      respond = (_req, res) => json(res, 200, WELL_FORMED);
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).resolves.toEqual(WELL_FORMED);
    });

    it('defaults a missing companyId to null for a non-owner kind (member/operator responses never carry one)', async () => {
      const member = { userId: 'u-2', kind: 'member', platformAssignments: [], organizationAdminMemberships: ['org-1'] };
      respond = (_req, res) => json(res, 200, member);
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).resolves.toEqual({ ...member, companyId: null });
    });

    it('fails CLOSED (ServiceUnavailableException) if companyId is renamed — the exact drift scenario the audit flagged (owner authority is load-bearing on this field)', async () => {
      const drifted = { ...WELL_FORMED, ownedCompanies: [WELL_FORMED.companyId] } as Record<string, unknown>;
      delete drifted.companyId; // simulate Auth renaming companyId -> ownedCompanies
      respond = (_req, res) => json(res, 200, drifted);
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED if a non-owner response unexpectedly carries a companyId', async () => {
      respond = (_req, res) => json(res, 200, { userId: 'u-3', kind: 'member', companyId: 'co-should-not-be-here', platformAssignments: [], organizationAdminMemberships: [] });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED if a required array field is missing entirely', async () => {
      const { platformAssignments: _drop, ...rest } = WELL_FORMED;
      respond = (_req, res) => json(res, 200, rest);
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED if kind is not one of the three known values', async () => {
      respond = (_req, res) => json(res, 200, { ...WELL_FORMED, kind: 'admin' });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED on malformed JSON in the response body', async () => {
      respond = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not json');
      };
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('translates a real 401 into UnauthorizedException', async () => {
      respond = (_req, res) => json(res, 401, { code: 'unauthorized' });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fails CLOSED on an unexpected status (e.g. a real 500 from Auth)', async () => {
      respond = (_req, res) => json(res, 500, { code: 'internal_error' });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED when Auth is unreachable (connection refused)', async () => {
      const client = new HttpAuthGrantsClient({ baseUrl: 'http://127.0.0.1:1' });
      await expect(client.grantsFor('b')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('verifyStepUp', () => {
    it("sends a POST to /auth/step-up/verify with the bearer forwarded and {purpose, stepUpToken} as the JSON body", async () => {
      respond = (_req, res) => res.writeHead(204).end();
      const client = new HttpAuthGrantsClient({ baseUrl });
      await client.verifyStepUp('the-users-own-bearer', 'platform.create', 'su-token-123');
      expect(lastRequest?.method).toBe('POST');
      expect(lastRequest?.url).toBe('/auth/step-up/verify');
      expect(lastRequest?.headers.authorization).toBe('Bearer the-users-own-bearer');
      expect(lastRequest?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(lastRequest?.body ?? '{}')).toEqual({ purpose: 'platform.create', stepUpToken: 'su-token-123' });
    });

    it('treats a real 204 as a verified, consumed step-up (true)', async () => {
      respond = (_req, res) => res.writeHead(204).end();
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.verifyStepUp('b', 'platform.create', 't')).resolves.toBe(true);
    });

    it.each([401, 403])('treats a real %i as a denial (false), never a throw', async (status) => {
      respond = (_req, res) => json(res, status, { code: 'denied' });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.verifyStepUp('b', 'platform.create', 't')).resolves.toBe(false);
    });

    it('fails CLOSED on an unexpected status', async () => {
      respond = (_req, res) => json(res, 500, { code: 'internal_error' });
      const client = new HttpAuthGrantsClient({ baseUrl });
      await expect(client.verifyStepUp('b', 'platform.create', 't')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails CLOSED when Auth is unreachable', async () => {
      const client = new HttpAuthGrantsClient({ baseUrl: 'http://127.0.0.1:1' });
      await expect(client.verifyStepUp('b', 'platform.create', 't')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
