import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError, FixtureOrganizationReference, HierarchyUnavailableError, HttpOrganizationReferenceClient, MemoizedOrganizationReference,
  parseOrganizationReferenceFixture, type OrganizationReference, type OrganizationReferenceResolver,
} from '../src/index.js';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const PLATFORM = 'bbbbbbbb-0000-4000-8000-000000000002';
const COMPANY = 'cccccccc-0000-4000-8000-000000000003';
const TOKEN = 'reference-credential-never-leaks';

/** A stand-in Organization Service: each test sets how it answers. */
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const seen: { url?: string; authorization?: string }[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

const json = (status: number, body: unknown) => (_: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const answer = { organizationId: ORG, platformId: PLATFORM, companyId: COMPANY };

function client(notices: string[] = [], timeoutMs = 300) {
  return new HttpOrganizationReferenceClient({ baseUrl: `${base}/`, serviceToken: TOKEN, timeoutMs, onNotice: (m) => notices.push(m) });
}
async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof HierarchyUnavailableError) return ['503', (e.getResponse() as { code: string }).code];
    if (e instanceof HttpException) return [String(e.getStatus())];
    throw e;
  }
}

describe('HttpOrganizationReferenceClient', () => {
  it('200 with the three ids: the anchors, asked with THIS service\'s own credential on the approved route', async () => {
    handler = json(200, answer);
    await expect(client().resolve(ORG.toUpperCase())).resolves.toEqual(answer);
    expect(seen[0]).toEqual({ url: `/organization/reference/organizations/${ORG}`, authorization: `Bearer ${TOKEN}` });
  });

  it('404 (unknown, or outside this service\'s scope at Organization Service): null, one collapsed answer', async () => {
    handler = json(404, { message: 'Not found.' });
    await expect(client().resolve(ORG)).resolves.toBeNull();
  });

  it('a value that is not a uuid is never sent anywhere', async () => {
    handler = json(200, answer);
    await expect(client().resolve('../../admin')).resolves.toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('409 not_authoritative (before the cutover): 503 hierarchy_unavailable, fail closed', async () => {
    const notices: string[] = [];
    handler = json(409, { code: 'not_authoritative' });
    expect(await outcome(client(notices).resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
    expect(notices).toEqual(['hierarchy_reference_unavailable reason=not_authoritative']);
  });

  it('5xx, 401 and 403 (a configuration fault): 503', async () => {
    for (const s of [500, 502, 503, 401, 403, 400, 204]) {
      handler = json(s, {});
      expect(await outcome(client().resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
    }
  });

  it('a redirect is refused, never followed: the credential goes nowhere else', async () => {
    handler = (_, res) => {
      res.writeHead(302, { location: `${base}/elsewhere` });
      res.end();
    };
    const notices: string[] = [];
    expect(await outcome(client(notices).resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
    expect(seen.map((s) => s.url)).toEqual([`/organization/reference/organizations/${ORG}`]);
    expect(notices[0]).toContain('redirect_refused');
  });

  it('a timeout: 503 (bounded, never hangs)', async () => {
    handler = () => undefined; // never answers
    const notices: string[] = [];
    const started = Date.now();
    expect(await outcome(client(notices, 150).resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(notices[0]).toContain('reason=timeout');
  });

  it('an unreachable authority: 503', async () => {
    const c = new HttpOrganizationReferenceClient({ baseUrl: 'http://127.0.0.1:1', serviceToken: TOKEN, timeoutMs: 500, onNotice: () => undefined });
    expect(await outcome(c.resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
  });

  it('malformed answers (wrong shape, wrong id, not JSON, extra-large): 503', async () => {
    const bodies: ((req: IncomingMessage, res: ServerResponse) => void)[] = [
      json(200, { organizationId: ORG, platformId: 'nope', companyId: COMPANY }),
      json(200, { ...answer, organizationId: 'dddddddd-0000-4000-8000-000000000004' }),
      json(200, [answer]),
      json(200, null),
      (_, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not json');
      },
      (_, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...answer, pad: 'x'.repeat(8 * 1024) })); // over the cap with no content-length trick
      },
      (_, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(1024 * 1024) });
        res.write('{');
      },
    ];
    for (const b of bodies) {
      handler = b;
      expect(await outcome(client().resolve(ORG))).toEqual(['503', 'hierarchy_unavailable']);
    }
  });

  it('no notice or error carries the credential, the URL or the authority\'s body', async () => {
    const notices: string[] = [];
    const errors: string[] = [];
    for (const h of [json(500, { secret: 'body-detail' }), json(401, {}), json(200, { leaked: TOKEN })]) {
      handler = h;
      try {
        await client(notices).resolve(ORG);
      } catch (e) {
        errors.push(JSON.stringify((e as HttpException).getResponse()));
      }
    }
    const all = [...notices, ...errors].join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('127.0.0.1');
    expect(all).not.toContain('body-detail');
  });
});

describe('MemoizedOrganizationReference', () => {
  const counting = (answers: Map<string, OrganizationReference | null | Error>) => {
    const calls: string[] = [];
    const inner: OrganizationReferenceResolver = {
      resolve: async (id) => {
        calls.push(id);
        const a = answers.get(id);
        if (a instanceof Error) throw a;
        return a ?? null;
      },
    };
    return { inner, calls };
  };

  it('a positive answer is reused (no second lookup), case-insensitively', async () => {
    const { inner, calls } = counting(new Map([[ORG, answer]]));
    const m = new MemoizedOrganizationReference(inner);
    await m.resolve(ORG);
    await expect(m.resolve(ORG.toUpperCase())).resolves.toEqual(answer);
    expect(calls).toEqual([ORG]);
  });

  it('a negative answer and a failure are never memoized: the next request asks the authority again', async () => {
    const answers = new Map<string, OrganizationReference | null | Error>([[ORG, null]]);
    const { inner, calls } = counting(answers);
    const m = new MemoizedOrganizationReference(inner);
    await expect(m.resolve(ORG)).resolves.toBeNull();
    answers.set(ORG, new HierarchyUnavailableError());
    await expect(m.resolve(ORG)).rejects.toBeInstanceOf(HierarchyUnavailableError);
    answers.set(ORG, answer);
    await expect(m.resolve(ORG)).resolves.toEqual(answer);
    expect(calls).toEqual([ORG, ORG, ORG]);
    expect(m.size).toBe(1);
  });

  it('while the authority is down, only already-memoized Organizations resolve', async () => {
    const other = 'eeeeeeee-0000-4000-8000-000000000005';
    const answers = new Map<string, OrganizationReference | null | Error>([[ORG, answer]]);
    const { inner } = counting(answers);
    const m = new MemoizedOrganizationReference(inner);
    await m.resolve(ORG);
    answers.set(ORG, new HierarchyUnavailableError());
    answers.set(other, new HierarchyUnavailableError());
    await expect(m.resolve(ORG)).resolves.toEqual(answer);
    await expect(m.resolve(other)).rejects.toBeInstanceOf(HierarchyUnavailableError);
  });

  it('is bounded: past the bound the least recently used entry is evicted and asked again', async () => {
    const ids = ['aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000c'];
    const { inner, calls } = counting(new Map(ids.map((id) => [id, { ...answer, organizationId: id }])));
    const m = new MemoizedOrganizationReference(inner, 2);
    await m.resolve(ids[0]!);
    await m.resolve(ids[1]!);
    await m.resolve(ids[0]!); // refreshes 0; 1 is now the oldest
    await m.resolve(ids[2]!); // evicts 1
    expect(m.size).toBe(2);
    await m.resolve(ids[1]!);
    expect(calls).toEqual([ids[0], ids[1], ids[2], ids[1]]);
  });

  it('a new process starts empty (nothing is persisted)', async () => {
    const { inner, calls } = counting(new Map([[ORG, answer]]));
    await new MemoizedOrganizationReference(inner).resolve(ORG);
    await new MemoizedOrganizationReference(inner).resolve(ORG);
    expect(calls).toEqual([ORG, ORG]);
  });

  it('refuses a non-positive bound', () => {
    expect(() => new MemoizedOrganizationReference({ resolve: async () => null }, 0)).toThrow(ConfigError);
  });
});

describe('the non-production fixture', () => {
  const raw = JSON.stringify([answer]);

  it('resolves only what it lists', async () => {
    const f = parseOrganizationReferenceFixture(raw, false);
    await expect(f.resolve(ORG)).resolves.toEqual(answer);
    await expect(f.resolve('ffffffff-0000-4000-8000-000000000009')).resolves.toBeNull();
  });

  it('is impossible to enable in production (parse and construction both refuse)', () => {
    expect(() => parseOrganizationReferenceFixture(raw, true)).toThrow(/refused in production/);
    expect(() => new FixtureOrganizationReference([answer], true)).toThrow(/refused in production/);
  });

  it('refuses malformed entries without echoing them', () => {
    expect(() => parseOrganizationReferenceFixture('{', false)).toThrow(/valid JSON/);
    expect(() => parseOrganizationReferenceFixture(JSON.stringify({ a: 1 }), false)).toThrow(/must be a list/);
    expect(() => parseOrganizationReferenceFixture(JSON.stringify([{ ...answer, extra: TOKEN }]), false)).toThrow(/exactly/);
    expect(() => parseOrganizationReferenceFixture(JSON.stringify([{ ...answer, platformId: TOKEN }]), false)).toThrow(/canonical lowercase uuids/);
    try {
      parseOrganizationReferenceFixture(JSON.stringify([{ ...answer, platformId: TOKEN }]), false);
    } catch (e) {
      expect((e as Error).message).not.toContain(TOKEN);
    }
  });
});
