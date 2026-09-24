import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type LoggerService, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeJwt } from 'jose';
import { generateSync } from 'otplib';
import pg from 'pg';
import request from 'supertest';
import { inject } from 'vitest';
import { JsonLogger, requestContextMiddleware } from '@nawara/service-kit';
import { AppModule } from '../../src/app.module.js';
import { AuthExceptionFilter } from '../../src/errors.js';
import { CLOCK, EVENT_BUS, type Clock, type EventBus } from '../../src/common/ports.js';
import { APP_CONFIG, loadConfig, type AppConfig } from '../../src/config/app-config.js';
import { generateJoinCode, hashJoinCode } from '../../src/crypto/join-code.js';
import { PasswordService } from '../../src/crypto/password.js';
import { DbService } from '../../src/db/db.service.js';
import { UsersService } from '../../src/users/users.service.js';

export class FakeClock implements Clock {
  constructor(private t = new Date()) {}
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
  set(d: Date) { this.t = d; }
}

export class RecordingBus implements EventBus {
  events: Array<{ key: string; payload: any }> = [];
  publish(key: string, payload: object) { this.events.push({ key, payload }); }
  last(key: string) { return [...this.events].reverse().find((e) => e.key === key)?.payload; }
  all(key: string) { return this.events.filter((e) => e.key === key).map((e) => e.payload); }
}

export class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push(...a: unknown[]) { this.lines.push(a.map(String).join(' ')); }
  log = (...a: unknown[]) => this.push(...a);
  error = (...a: unknown[]) => this.push(...a);
  warn = (...a: unknown[]) => this.push(...a);
  debug = (...a: unknown[]) => this.push(...a);
  verbose = (...a: unknown[]) => this.push(...a);
  fatal = (...a: unknown[]) => this.push(...a);
}

const RATE_BUCKETS = ['LOGIN_IP', 'LOGIN_IDENTIFIER', 'REGISTER_IP', 'REFRESH_IP', 'OWNER_VERIFY_OWNER', 'OWNER_VERIFY_IP', 'STEP_UP_OWNER', 'STEP_UP_IP',
  'FACTOR_ENROLL_OWNER', 'RECOVERY_IP', 'RECOVERY_IDENTIFIER', 'OPERATOR_REQUEST_IDENTIFIER', 'OPERATOR_REQUEST_IP', 'OPERATOR_VERIFY_IDENTIFIER',
  'OPERATOR_VERIFY_IP', 'OPERATOR_VERIFY_GLOBAL', 'OPERATOR_CONFIRM_IP',
  'JOIN_CODE_RESOLVE_IP', 'JOIN_CODE_RESOLVE_GLOBAL', 'JOIN_CODE_MANAGE_ACTOR', 'MEMBERSHIP_OP_ACTOR', 'MEMBERSHIP_JOIN_USER', 'CONTACT_REQUEST_USER', 'CONTACT_VERIFY_USER', 'CONTACT_VERIFY_IP',
  'INVITATION_RESOLVE_IP', 'INVITATION_RESOLVE_GLOBAL', 'INVITATION_ACCEPT_IP', 'INVITATION_MANAGE_ACTOR'];

const rand = () => randomBytes(32).toString('base64');

export type TestCtx = Awaited<ReturnType<typeof createTestApp>>;

/** A fully wired app against its own database cloned from the migrated template. */
/**
 * `extra.realEvents` (Stage 16.2): keep the REAL event wiring (the kit `RabbitMqEventBus` behind `EventsPublisherService`) against the
 * broker at that URL instead of the recording bus; `bus` then records nothing.
 */
export async function createTestApp(overrides: Record<string, string> = {}, extra: { providers?: Provider[]; realEvents?: { rabbitmqUrl: string } } = {}) {
  const adminUrl = inject('pgAdminUrl');
  const dbName = `t_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${inject('pgTemplate')}`);
  await admin.end();
  const databaseUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);

  const env: Record<string, string> = {
    NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_EVENTS: 'off', // no RabbitMQ in tests; events are captured by a recording bus
    JWT_SECRET: rand(), OPERATOR_CODE_PEPPER: rand(), SECRET_KEY_PEPPER: rand(), THROTTLE_KEY_PEPPER: rand(), JOIN_CODE_PEPPER: rand(),
    TOTP_ENCRYPTION_KEYS: `k1:${rand()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    WEBAUTHN_RP_ID: 'auth.test', WEBAUTHN_ORIGINS: 'https://auth.test',
    BCRYPT_COST: '4', ACCESS_TOKEN_TTL_SEC: '3600', RECOVERY_COOLDOWN_SEC: '3600', WORK_TIMEZONE: 'UTC',
    ...Object.fromEntries(RATE_BUCKETS.map((b) => [`RATE_${b}_LIMIT`, '100000'])),
    ...(extra.realEvents ? { AUTH_EVENTS: 'on', RABBITMQ_URL: extra.realEvents.rabbitmqUrl } : {}),
    ...overrides,
  };
  const cfg: AppConfig = loadConfig(env as NodeJS.ProcessEnv);
  const clock = new FakeClock();
  const bus = new RecordingBus();
  const logger = new CapturingLogger();

  const builder = Test.createTestingModule({ imports: [AppModule.register(cfg)], providers: extra.providers ?? [] })
    .overrideProvider(APP_CONFIG).useValue(cfg)
    .overrideProvider(CLOCK).useValue(clock);
  if (!extra.realEvents) builder.overrideProvider(EVENT_BUS).useValue(bus);
  const moduleRef = await builder.setLogger(logger).compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(logger);
  // Same HTTP baseline main.ts wires (Stage 13.2): request-context first, then the additive exception
  // filter. A SEPARATE real JsonLogger (not the CapturingLogger above) feeds the filter, exactly as
  // production does; its structured JSON lines are captured here for tests that need to inspect them.
  const jsonLogs: Record<string, unknown>[] = [];
  const jsonLogger = new JsonLogger('auth-service', 'debug', (l) => jsonLogs.push(JSON.parse(l)));
  app.use(requestContextMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new AuthExceptionFilter(jsonLogger));
  app.enableShutdownHooks();
  await app.init();

  const db = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  const http = request(app.getHttpServer());
  const users = app.get(UsersService);
  const passwords = app.get(PasswordService);
  const dbs = app.get(DbService);

  const ctx = {
    app, cfg, clock, bus, logger, jsonLogs, db, http, users, dbs, env,
    async close() {
      await db.end();
      await app.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },

    // ------------------------------------------------------------------ fixtures
    async world() {
      const id = () => randomUUID();
      const w = { companyA: id(), companyB: id(), platformSchool: id(), platformDrive: id(), platformClinic: id(), orgSchool1: id(), orgSchool2: id(), orgDrive: id(), orgClinic: id() };
      await db.query(`INSERT INTO company(id,name) VALUES ($1,'A'),($2,'B')`, [w.companyA, w.companyB]);
      await db.query(`INSERT INTO platform(id,"companyId",name) VALUES ($1,$4,'School'),($2,$4,'Drive'),($3,$5,'Clinic')`, [w.platformSchool, w.platformDrive, w.platformClinic, w.companyA, w.companyB]);
      await db.query(`INSERT INTO organization(id,"platformId",name) VALUES ($1,$5,'School 1'),($2,$5,'School 2'),($3,$6,'Drive 1'),($4,$7,'Clinic 1')`, [w.orgSchool1, w.orgSchool2, w.orgDrive, w.orgClinic, w.platformSchool, w.platformDrive, w.platformClinic]);
      return w;
    },
    /** a fresh company (the database allows exactly ONE owner per company) */
    async newCompany() {
      const id = randomUUID();
      await db.query(`INSERT INTO company(id,name) VALUES ($1,'C')`, [id]);
      return id;
    },
    async owner(companyId: string, email: string, password = 'correct horse battery') {
      const hash = await passwords.hash(password);
      const u = await dbs.tx((q) => users.createOwner({ companyId, email, passwordHash: hash }, q));
      return { id: u.id, email, password, companyId };
    },
    /**
     * A member identity with ONE membership (default active), created in one transaction as production does: a member
     * must always have at least one membership. `audience` is only the opaque onboarding label on the membership.
     */
    async member(organizationId: string, email: string, password = 'member password 1', audience = 'student', status: 'pending' | 'active' | 'rejected' = 'active') {
      const hash = await passwords.hash(password);
      const u = await dbs.tx(async (q) => {
        const user = await users.createMember({ email, passwordHash: hash }, q);
        await ctx.addMembership(user.id, organizationId, audience, status, q);
        return user;
      });
      return { id: u.id, email, password };
    },
    /**
     * A member identity with ZERO memberships (owner decision 2026-09-20, migration 0009: member is now
     * [0..N]). Identity only — no organization relationship, and therefore no organization authority.
     */
    async memberNoOrg(email: string, password = 'member password 1') {
      const hash = await passwords.hash(password);
      const u = await dbs.tx((q) => users.createMember({ email, passwordHash: hash }, q));
      return { id: u.id, email, password };
    },
    /** Another organization relationship for an EXISTING user (one identity, many organizations). */
    async addMembership(userId: string, organizationId: string, audience = 'student', status: 'pending' | 'active' | 'rejected' | 'revoked' = 'active', q: { query: (sql: string, p?: unknown[]) => Promise<unknown> } = db) {
      if (status === 'active') {
        await q.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt") VALUES ($1,$2,'active',$3,now())`, [userId, organizationId, audience]);
      } else if (status === 'pending') {
        await q.query(`INSERT INTO organization_membership("userId","organizationId",status,audience) VALUES ($1,$2,'pending',$3)`, [userId, organizationId, audience]);
      } else if (status === 'rejected') {
        await q.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"rejectedAt","rejectedBy") VALUES ($1,$2,'rejected',$3,now(),$1)`, [userId, organizationId, audience]);
      } else {
        await q.query(`INSERT INTO organization_membership("userId","organizationId",status,audience,"approvedAt","revokedAt","revokedBy") VALUES ($1,$2,'revoked',$3,now(),now(),$1)`, [userId, organizationId, audience]);
      }
    },
    /** A join code inserted directly (fast fixture). Returns the plaintext once, like the API does. */
    async joinCode(organizationId: string, o: { audience?: string; requiresApproval?: boolean; requiresSubscription?: boolean; maxUses?: number | null; createdBy?: string; expiresInDays?: number } = {}) {
      const org = await db.query(`SELECT o."platformId", p."companyId" FROM organization o JOIN platform p ON p.id = o."platformId" WHERE o.id = $1`, [organizationId]);
      const creator = o.createdBy ?? (await ctx.operator(org.rows[0].companyId, `jc${randomUUID().slice(0, 8)}@x.test`)).id;
      const gen = generateJoinCode('DRIVE');
      const ins = await db.query(
        `INSERT INTO organization_join_code("organizationId","platformId","codeHash",audience,"requiresApproval","requiresSubscription","expiresAt","maxUses","createdBy")
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8, $9) RETURNING id`,
        [organizationId, org.rows[0].platformId, hashJoinCode(cfg.secrets.joinCodePepper, gen.normalized), o.audience ?? 'student',
          o.requiresApproval ?? false, o.requiresSubscription ?? true, String(o.expiresInDays ?? 30), o.maxUses ?? null, creator],
      );
      return { id: ins.rows[0].id as string, code: gen.display, normalized: gen.normalized };
    },
    async operator(companyId: string, email: string, confirmed = true) {
      const u = await dbs.tx((q) => users.createOperator({ companyId, email }, q));
      if (confirmed) await db.query(`UPDATE operator SET "contactVerifiedAt"=now() WHERE "userId"=$1`, [u.id]);
      return { id: u.id, email };
    },
    async assign(operatorId: string, platformId: string, ownerId: string, companyId: string) {
      await db.query(`INSERT INTO platform_assignment("operatorId","platformId","companyId","assignedBy") VALUES ($1,$2,$3,$4)`, [operatorId, platformId, companyId, ownerId]);
    },

    // ------------------------------------------------------------------ flows
    /** A TOTP code for a time step the service has not seen (advances the fake clock one step). */
    nextCode(secret: string) {
      clock.advance(31_000);
      return generateSync({ secret, strategy: 'totp', epoch: Math.floor(clock.now().getTime() / 1000) } as any);
    },
    /** bootstrap path: password -> enrollment_required -> enroll TOTP -> first session. */
    async enrollFirstTotp(o: { email: string; password: string }) {
      const login = await http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
      expect(login.body.status).toBe('enrollment_required');
      const begin = await http.post('/auth/admin/enroll/totp').send({ enrollmentToken: login.body.enrollmentToken }).expect(200);
      const confirm = await http.post('/auth/admin/enroll/totp/confirm')
        .send({ enrollmentToken: login.body.enrollmentToken, factorId: begin.body.factorId, code: ctx.nextCode(begin.body.secret) }).expect(200);
      return { totpSecret: begin.body.secret as string, factorId: begin.body.factorId as string, tokens: confirm.body as Tokens };
    },
    /** normal owner login: password -> mfa_required -> TOTP -> session. */
    async ownerLogin(o: { email: string; password: string }, totpSecret: string) {
      const login = await http.post('/auth/login').send({ email: o.email, password: o.password }).expect(200);
      expect(login.body.status).toBe('mfa_required');
      const v = await http.post('/auth/admin/login/owner/verify').send({ challengeToken: login.body.challengeToken, method: 'totp', code: ctx.nextCode(totpSecret) }).expect(200);
      return v.body as Tokens;
    },
    /** A ready owner with a TOTP factor and a live session. */
    async readyOwner(companyId: string, email: string) {
      const o = await ctx.owner(companyId, email);
      const e = await ctx.enrollFirstTotp(o);
      return { ...o, totpSecret: e.totpSecret, tokens: e.tokens };
    },
    async stepUp(tokens: Tokens, purpose: string, totpSecret: string, extra: Record<string, unknown> = {}) {
      const r = await http.post('/auth/admin/step-up').set(bearer(tokens)).send({ purpose, method: 'totp', code: ctx.nextCode(totpSecret), ...extra });
      return r;
    },
    async stepUpToken(tokens: Tokens, purpose: string, totpSecret: string) {
      const r = await ctx.stepUp(tokens, purpose, totpSecret);
      expect(r.status).toBe(200);
      return r.body.stepUpToken as string;
    },
    /** Operator: request a code, read it from the notification event, redeem it. */
    async operatorCode(email: string) {
      const before = bus.all('admin.operator_code_issued').length;
      await http.post('/auth/admin/login/operator/request-code').send({ email }).expect(204);
      const evs = bus.all('admin.operator_code_issued');
      return evs.length > before ? (evs[evs.length - 1].code as string) : undefined;
    },
    async operatorLogin(email: string) {
      const code = await ctx.operatorCode(email);
      const r = await http.post('/auth/admin/login/operator/verify-code').send({ email, code });
      expect(r.status).toBe(200);
      return r.body as Tokens;
    },
  };
  return ctx;
}

export interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }
export const bearer = (t: Tokens | string) => ({ Authorization: `Bearer ${typeof t === 'string' ? t : t.accessToken}` });
export const claims = (t: Tokens) => decodeJwt(t.accessToken);

/**
 * An error body minus `requestId` (Stage 13.2): every request now gets its own correlation id, by design, so
 * two responses that are otherwise byte-identical (the whole point of a collapsed 404/401/403) legitimately
 * differ on that one field. Tests that prove "these two responses are indistinguishable" compare this instead
 * of the raw body — `requestId` is observability metadata, not part of that security property.
 */
export const noReqId = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const { requestId: _requestId, ...rest } = body as Record<string, unknown>;
  return rest;
};
