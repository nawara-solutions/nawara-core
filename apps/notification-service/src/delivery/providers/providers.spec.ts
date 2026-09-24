import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderStub, closedPortUrl } from '../../../test/support/provider-stub.js';
import type { ProviderCallContext, ProviderResult } from '../provider.js';
import type { RenderedMessage } from '../renderer.js';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from './http.js';
import { ResendEmailProvider } from './resend.js';
import { TwilioSmsProvider } from './twilio.js';

/**
 * Stage 16.8 contract tests: the Resend and Twilio adapters against a local HTTP stand-in (no real provider, no network). Each
 * documented provider answer and each transport failure maps to the port's classification boundary.
 */
const RESEND_KEY = 're_SentinelResendKey_0123456789';
const TWILIO = { accountSid: `AC${'1'.repeat(32)}`, apiKeySid: `SK${'2'.repeat(32)}`, apiKeySecret: 'SentinelTwilioSecret0123456789ab', messagingServiceSid: `MG${'3'.repeat(32)}` };
const FROM = 'Nawara <no-reply@notify.example.com>';
const PII = 'pii-sentinel+21698765432@leak.example';
const FR = 'Votre code de vérification : 740263 — ne le partagez pas. Où ? Déjà, à bientôt.';
const AR = 'رمز التحقق الخاص بك هو 740263. لا تشاركه مع أي شخص.';
const SID = `SM${'a'.repeat(32)}`;

const ctx = (over: Partial<ProviderCallContext> = {}): ProviderCallContext => ({
  reference: 'd-1', attemptId: 'a-1', idempotencyKey: 'nawara-notification/d-1/0', signal: AbortSignal.timeout(2000), ...over,
});
const email = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({ channel: 'EMAIL', destination: 'user@example.test', subject: 'Votre code', text: FR, html: `<p>${AR}</p>`, ...over });
const sms = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({ channel: 'SMS', destination: '+21698765432', text: AR, ...over });

describe('real provider adapters (local HTTP stand-in)', () => {
  const stub = new ProviderStub();
  let resend: ResendEmailProvider;
  let twilio: TwilioSmsProvider;
  beforeAll(async () => {
    await stub.start();
    resend = new ResendEmailProvider({ apiKey: RESEND_KEY, from: FROM, baseUrl: stub.url });
    twilio = new TwilioSmsProvider({ ...TWILIO, baseUrl: stub.url });
  });
  beforeEach(() => stub.reset());
  afterAll(() => stub.close());

  const noLeak = (r: ProviderResult) => {
    const s = JSON.stringify(r);
    for (const x of [PII, RESEND_KEY, TWILIO.apiKeySecret, '740263', 'user@example.test', '+21698765432']) expect(s).not.toContain(x);
  };

  describe('Resend (email)', () => {
    it('accepted: POST /emails with the bearer key, the idempotency key, the configured sender and the rendered UTF-8 content, unchanged', async () => {
      stub.behaviour = { kind: 'json', status: 200, body: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } };
      const r = await resend.send(email({ subject: 'Vérification — تحقق' }), ctx());
      expect(r).toEqual({ kind: 'accepted', providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', diagnostic: { httpStatus: 200 } });
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: '/emails' });
      expect(req.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
      expect(req.headers['idempotency-key']).toBe('nawara-notification/d-1/0');
      expect(req.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(req.body)).toEqual({ from: FROM, to: ['user@example.test'], subject: 'Vérification — تحقق', text: FR, html: `<p>${AR}</p>` });
    });

    it('sends no html key when there is no HTML part; a sender smuggled in the message is ignored (server-owned sender)', async () => {
      stub.behaviour = { kind: 'json', status: 200, body: { id: 'x-1' } };
      await resend.send({ ...email({ html: undefined }), from: 'attacker@evil.test', replyTo: 'attacker@evil.test' } as RenderedMessage, ctx());
      const body = JSON.parse(stub.requests[0].body);
      expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
      expect(body.from).toBe(FROM);
    });

    it.each([
      [429, 'rate_limit_exceeded', { 'retry-after': '7' }, { kind: 'rejected', failureClass: 'retryable', code: 'provider_rate_limited', retryAfterMs: 7000 }],
      [429, 'daily_quota_exceeded', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_rate_limited' }],
      [403, 'email_above_quota', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_rate_limited' }],
      [500, 'application_error', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_unavailable' }],
      [503, 'service_unavailable', { 'retry-after': '3' }, { kind: 'rejected', failureClass: 'retryable', code: 'provider_unavailable', retryAfterMs: 3000 }],
      [502, undefined, {}, { kind: 'ambiguous', code: 'provider_gateway_timeout' }],
      [504, undefined, {}, { kind: 'ambiguous', code: 'provider_gateway_timeout' }],
      [401, 'missing_api_key', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_auth_fault' }],
      [403, 'restricted_api_key', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_auth_fault' }],
      [403, 'validation_error', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_auth_fault' }], // unverified domain
      [404, 'not_found', {}, { kind: 'rejected', failureClass: 'retryable', code: 'provider_config_fault' }],
      [422, 'validation_error', {}, { kind: 'rejected', failureClass: 'terminal', code: 'provider_rejected' }],
      [400, 'validation_error', {}, { kind: 'rejected', failureClass: 'terminal', code: 'provider_rejected' }],
      [409, 'invalid_idempotent_request', {}, { kind: 'ambiguous', code: 'provider_idempotency_conflict' }],
      [409, 'concurrent_idempotent_requests', {}, { kind: 'ambiguous', code: 'provider_idempotency_conflict' }],
      [301, undefined, { location: 'https://elsewhere.example' }, { kind: 'rejected', failureClass: 'retryable', code: 'provider_config_fault' }],
    ] as const)('HTTP %i %s → %j (no provider text kept)', async (status, name, headers, expected) => {
      stub.behaviour = { kind: 'json', status, headers: { ...headers }, body: name ? { statusCode: status, name, message: `The to field is invalid: ${PII}` } : undefined };
      const r = await resend.send(email(), ctx());
      expect(r).toMatchObject(expected);
      expect(r.diagnostic).toEqual({ httpStatus: status, ...(name ? { providerCode: name } : {}) });
      noLeak(r);
    });

    it.each([
      ['a body that is not JSON', { kind: 'raw', status: 200, body: `<html>${PII}</html>` }],
      ['JSON without an id', { kind: 'json', status: 200, body: { message: PII } }],
      ['an id with foreign characters', { kind: 'json', status: 200, body: { id: `${PII} <script>` } }],
      ['an over-long id', { kind: 'json', status: 200, body: { id: 'a'.repeat(129) } }],
      ['an oversized body (> 64 KiB)', { kind: 'raw', status: 200, body: JSON.stringify({ id: 'x', pad: 'p'.repeat(70_000) }) }],
    ] as const)('an accepted status with %s is AMBIGUOUS provider_invalid_response (never resent blindly, never stored)', async (_l, b) => {
      stub.behaviour = b;
      const r = await resend.send(email(), ctx());
      expect(r).toMatchObject({ kind: 'ambiguous', code: 'provider_invalid_response' });
      noLeak(r);
    });

    it('a request refused before any byte is sent (connection refused) is RETRYABLE provider_unreachable', async () => {
      const p = new ResendEmailProvider({ apiKey: RESEND_KEY, from: FROM, baseUrl: await closedPortUrl() });
      expect(await p.send(email(), ctx())).toEqual({ kind: 'rejected', failureClass: 'retryable', code: 'provider_unreachable', retryAfterMs: undefined, diagnostic: undefined });
    });

    it('a DNS failure is RETRYABLE provider_unreachable', async () => {
      // `.invalid` never resolves (RFC 2606); a slow resolver gets a generous budget so the lookup, not the abort, ends the call.
      const p = new ResendEmailProvider({ apiKey: RESEND_KEY, from: FROM, baseUrl: 'http://nawara-provider-stub.invalid' });
      expect(await p.send(email(), ctx({ signal: AbortSignal.timeout(20_000) }))).toMatchObject({ kind: 'rejected', failureClass: 'retryable', code: 'provider_unreachable' });
    }, 30_000);

    it('the connection lost after the request was sent is AMBIGUOUS provider_connection_lost', async () => {
      stub.behaviour = { kind: 'reset' };
      expect(await resend.send(email(), ctx())).toMatchObject({ kind: 'ambiguous', code: 'provider_connection_lost' });
      expect(stub.requests).toHaveLength(1);
    });

    it('the engine signal aborts a hanging call: AMBIGUOUS provider_timeout, and the socket is closed (not just abandoned)', async () => {
      stub.behaviour = { kind: 'hang' };
      const t0 = Date.now();
      const r = await resend.send(email(), ctx({ signal: AbortSignal.timeout(150) }));
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(r).toMatchObject({ kind: 'ambiguous', code: 'provider_timeout' });
      await new Promise((t) => setTimeout(t, 50));
      expect(stub.clientAborts).toBe(1);
    });

    it('defensive checks: a non-email destination or a subject with a line break is never sent', async () => {
      expect(await resend.send(email({ destination: '+21698765432' }), ctx())).toMatchObject({ failureClass: 'terminal', code: 'invalid_destination' });
      expect(await resend.send(email({ subject: 'Hi\r\nBcc: x@evil.test' }), ctx())).toMatchObject({ failureClass: 'terminal', code: 'provider_invalid_request' });
      expect(await resend.send(email({ subject: undefined }), ctx())).toMatchObject({ failureClass: 'terminal' });
      expect(stub.requests).toHaveLength(0);
    });
  });

  describe('Twilio (SMS)', () => {
    it('accepted: form POST to the account Messages resource with the API key, the Messaging Service and the Arabic body intact', async () => {
      stub.behaviour = { kind: 'json', status: 201, body: { sid: SID, status: 'accepted', body: AR, to: '+21698765432' } };
      const r = await twilio.send(sms(), ctx());
      expect(r).toEqual({ kind: 'accepted', providerMessageId: SID, diagnostic: { httpStatus: 201 } });
      const [req] = stub.requests;
      expect(req).toMatchObject({ method: 'POST', path: `/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json` });
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${TWILIO.apiKeySid}:${TWILIO.apiKeySecret}`).toString('base64')}`);
      expect(req.headers['idempotency-key']).toBeUndefined(); // Twilio has none: §8.5 alone protects an ambiguity
      const form = new URLSearchParams(req.body);
      expect([...form.keys()].sort()).toEqual(['Body', 'MessagingServiceSid', 'To']);
      expect(form.get('To')).toBe('+21698765432');
      expect(form.get('MessagingServiceSid')).toBe(TWILIO.messagingServiceSid);
      expect(form.get('Body')).toBe(AR);
    });

    it('French accents survive the form encoding', async () => {
      stub.behaviour = { kind: 'json', status: 201, body: { sid: SID } };
      await twilio.send(sms({ text: FR }), ctx());
      expect(new URLSearchParams(stub.requests[0].body).get('Body')).toBe(FR);
    });

    it.each(['22123456', '21622123456', '0021622123456', '+0216221234', '+216 22 123 456', '022123456'])('%s is never normalized: terminal invalid_destination, nothing sent', async (dest) => {
      expect(await twilio.send(sms({ destination: dest }), ctx())).toMatchObject({ kind: 'rejected', failureClass: 'terminal', code: 'invalid_destination' });
      expect(stub.requests).toHaveLength(0);
    });

    it('a body over Twilio’s 1600-character limit is content_too_long and never sent (never truncated)', async () => {
      expect(await twilio.send(sms({ text: 'ب'.repeat(1601) }), ctx())).toMatchObject({ failureClass: 'terminal', code: 'content_too_long' });
      expect(stub.requests).toHaveLength(0);
    });

    it.each([
      [400, 21211, {}, { failureClass: 'terminal', code: 'destination_rejected' }],
      [400, 21610, {}, { failureClass: 'terminal', code: 'destination_rejected' }],
      [400, 21612, {}, { failureClass: 'terminal', code: 'destination_rejected' }],
      [400, 21614, {}, { failureClass: 'terminal', code: 'destination_rejected' }],
      [400, 21617, {}, { failureClass: 'terminal', code: 'content_too_long' }],
      [400, 21408, {}, { failureClass: 'retryable', code: 'provider_config_fault' }],
      [400, 21606, {}, { failureClass: 'retryable', code: 'provider_config_fault' }],
      [400, 21703, {}, { failureClass: 'retryable', code: 'provider_config_fault' }],
      [404, 20404, {}, { failureClass: 'retryable', code: 'provider_config_fault' }],
      [401, 20003, {}, { failureClass: 'retryable', code: 'provider_auth_fault' }],
      [403, 20003, {}, { failureClass: 'retryable', code: 'provider_auth_fault' }],
      [429, 20429, { 'retry-after': '11' }, { failureClass: 'retryable', code: 'provider_rate_limited', retryAfterMs: 11_000 }],
      [429, undefined, {}, { failureClass: 'retryable', code: 'provider_rate_limited' }],
      [500, 20500, {}, { failureClass: 'retryable', code: 'provider_unavailable' }],
      [503, undefined, {}, { failureClass: 'retryable', code: 'provider_unavailable' }],
      [400, 21999, {}, { failureClass: 'terminal', code: 'provider_rejected' }],
    ] as const)('HTTP %i code %s → %j', async (status, code, headers, expected) => {
      stub.behaviour = { kind: 'json', status, headers: { ...headers }, body: code ? { code, message: `The 'To' number ${PII} is not valid`, more_info: `https://www.twilio.com/docs/errors/${code}`, status } : undefined };
      const r = await twilio.send(sms(), ctx());
      expect(r).toMatchObject({ kind: 'rejected', ...expected });
      expect(r.diagnostic).toEqual({ httpStatus: status, ...(code ? { providerCode: String(code) } : {}) });
      noLeak(r);
    });

    it.each([
      [502, { kind: 'ambiguous', code: 'provider_gateway_timeout' }],
      [504, { kind: 'ambiguous', code: 'provider_gateway_timeout' }],
    ] as const)('HTTP %i (a gateway lost the upstream answer) → AMBIGUOUS', async (status, expected) => {
      stub.behaviour = { kind: 'raw', status, body: `<html>${PII}</html>` };
      expect(await twilio.send(sms(), ctx())).toMatchObject(expected);
    });

    it.each([
      ['non-JSON', { kind: 'raw', status: 201, body: 'OK' }],
      ['no sid', { kind: 'json', status: 201, body: { status: 'queued' } }],
      ['a malformed sid', { kind: 'json', status: 201, body: { sid: 'SM123' } }],
    ] as const)('a 201 with %s is AMBIGUOUS provider_invalid_response', async (_l, b) => {
      stub.behaviour = b;
      expect(await twilio.send(sms(), ctx())).toMatchObject({ kind: 'ambiguous', code: 'provider_invalid_response' });
    });

    it('transport: refused → retryable before sending; reset after sending → ambiguous; hang → ambiguous timeout with the socket closed', async () => {
      const refused = new TwilioSmsProvider({ ...TWILIO, baseUrl: await closedPortUrl() });
      expect(await refused.send(sms(), ctx())).toMatchObject({ failureClass: 'retryable', code: 'provider_unreachable' });
      stub.behaviour = { kind: 'reset' };
      expect(await twilio.send(sms(), ctx())).toMatchObject({ kind: 'ambiguous', code: 'provider_connection_lost' });
      stub.behaviour = { kind: 'hang' };
      expect(await twilio.send(sms(), ctx({ signal: AbortSignal.timeout(150) }))).toMatchObject({ kind: 'ambiguous', code: 'provider_timeout' });
      await new Promise((t) => setTimeout(t, 50));
      expect(stub.clientAborts).toBe(1);
    });
  });

  describe('Retry-After normalization', () => {
    it('delta-seconds or an HTTP date, bounded to [0, 24 h]; anything else is ignored', () => {
      const now = Date.parse('2026-09-24T10:00:00Z');
      expect(parseRetryAfter('0', now)).toBe(0);
      expect(parseRetryAfter('120', now)).toBe(120_000);
      expect(parseRetryAfter('Thu, 24 Sep 2026 10:01:00 GMT', now)).toBe(60_000);
      expect(parseRetryAfter('Thu, 24 Sep 2026 09:00:00 GMT', now)).toBe(0);
      expect(parseRetryAfter('999999999', now)).toBe(MAX_RETRY_AFTER_MS);
      for (const bad of [null, '', '-5', '1.5', 'soon', '12abc']) expect(parseRetryAfter(bad, now)).toBeUndefined();
    });
  });
});
