import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  RECEIPT_DOMAINS, bindingDigest, canonicalBinding, parseBinding, requestHash, secretDigest,
} from './receipt-binding.js';
import { ReceiptError } from './receipt-errors.js';

/** S2-Auth.1 (ADR-0067; D-A2 receipt contract §5.1, §6): the binding's strict parse, its canonical form and the digests' domains. */
const valid = () => ({
  operation: 'refund', audience: 'payment-service', companyId: '11111111-1111-4111-8111-111111111111',
  refundCaseId: '22222222-2222-4222-8222-222222222222', paymentId: '33333333-3333-4333-8333-333333333333',
  amount: 4900, currency: 'TND', reason: 'duplicate_charge', legalOverride: false,
});
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof ReceiptError ? e.code : `not a ReceiptError: ${String(e)}`; }
  return 'no error';
};

describe('authorization receipt binding (S2-Auth.1)', () => {
  it('parses exactly the frozen F-2 fields; legalOverride is false unless given (Q1)', () => {
    expect(parseBinding(valid())).toEqual(valid());
    const { legalOverride: _omit, ...rest } = valid();
    expect(parseBinding(rest).legalOverride).toBe(false);
    expect(parseBinding({ ...valid(), legalOverride: true }).legalOverride).toBe(true);
  });

  it('refuses anything unknown, missing or mistyped with receipt_binding_invalid', () => {
    const bad: Array<[string, unknown]> = [
      ['not an object', 'x'], ['null', null], ['an array', [valid()]], ['a class instance', new (class { a = 1; })()],
      ['an unknown field', { ...valid(), extra: 1 }], ['a missing field', (({ reason: _r, ...o }) => o)(valid())],
      ['another operation', { ...valid(), operation: 'charge' }], ['another audience', { ...valid(), audience: 'billing-service' }],
      ['an upper-case uuid', { ...valid(), paymentId: '33333333-3333-4333-8333-33333333333A' }], ['a non-uuid', { ...valid(), companyId: 'c1' }],
      ['amount 0', { ...valid(), amount: 0 }], ['a negative amount', { ...valid(), amount: -1 }], ['a fractional amount', { ...valid(), amount: 1.5 }],
      ['an unsafe amount', { ...valid(), amount: 2 ** 53 }], ['a string amount', { ...valid(), amount: '4900' }],
      ['a lower-case currency', { ...valid(), currency: 'tnd' }], ['a 4-letter currency', { ...valid(), currency: 'TNDX' }],
      ['free-text reason (Q2)', { ...valid(), reason: 'The customer asked nicely' }], ['an upper-case reason', { ...valid(), reason: 'Duplicate' }],
      ['an over-long reason', { ...valid(), reason: `r${'x'.repeat(64)}` }], ['a string legalOverride', { ...valid(), legalOverride: 'true' }],
      ['a null legalOverride', { ...valid(), legalOverride: null }],
    ];
    for (const [what, b] of bad) expect(code(() => parseBinding(b)), what).toBe('receipt_binding_invalid');
  });

  it('the canonical form is independent of key order and never includes anything but the F-2 fields', () => {
    const a = valid();
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(canonicalBinding(parseBinding(reordered))).toBe(canonicalBinding(parseBinding(a)));
    expect(canonicalBinding(parseBinding(a))).toBe(
      '{"amount":4900,"audience":"payment-service","companyId":"11111111-1111-4111-8111-111111111111","currency":"TND","legalOverride":false,'
      + '"operation":"refund","paymentId":"33333333-3333-4333-8333-333333333333","reason":"duplicate_charge",'
      + '"refundCaseId":"22222222-2222-4222-8222-222222222222"}',
    );
    expect(canonicalBinding(parseBinding({ ...a, legalOverride: true }))).not.toBe(canonicalBinding(parseBinding(a)));
  });

  it('digests are domain-separated, peppered and versioned: the same input never yields the same digest in two roles', () => {
    const pepper = randomBytes(32);
    const c = canonicalBinding(parseBinding(valid()));
    const d = [bindingDigest(pepper, c), requestHash(pepper, c), secretDigest(pepper, c)];
    for (const x of d) expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(d).size).toBe(3);
    expect(bindingDigest(randomBytes(32), c)).not.toBe(d[0]);
    expect(Object.values(RECEIPT_DOMAINS).every((v) => v.endsWith('.v1'))).toBe(true);
  });
});

describe('authorization receipts stay unreachable until S2-Auth.2', () => {
  it('no controller, route or module other than the app module references the receipt service or a receipt route', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== 'receipts') walk(path); continue; }
        if (!name.endsWith('.ts') || name.endsWith('.spec.ts') || name === 'app.module.ts') continue;
        const text = readFileSync(path, 'utf8');
        if (/AuthorizationReceiptService|authorization-receipts|receipts\//.test(text)) hits.push(path.slice(src.length));
      }
    };
    walk(src);
    expect(hits).toEqual([]);
  });
});
