import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stage 21.C.2 (ADR-0052): Payment and Billing admit service callers only through an explicit caller policy (deny by default) and verify
 * every Organization a caller names through Organization Service's reference read. These cross-process suites exercise OTHER behavior
 * (the Billing <-> Payment loop, audit production), so they run the services with a TEST-ONLY policy and a stand-in reference read that
 * places every Organization in one test Platform. The real admission and verification rules are certified by each service's own
 * `caller-admission.e2e-spec.ts`. Nothing here is a production configuration.
 */
export const TEST_PLATFORM = 'aaaaaaaa-0000-4000-8000-00000000a11f';
const TEST_COMPANY = 'aaaaaaaa-0000-4000-8000-00000000c0de';
const TOKEN = 'stand-in-reference-credential-0000000000000';

export interface ReferenceStub {
  env: { ORGANIZATION_SERVICE_URL: string; ORGANIZATION_REFERENCE_TOKEN: string };
  close(): Promise<void>;
}

/** A stand-in for `GET /organization/reference/organizations/:id`: any uuid is an Organization of TEST_PLATFORM. */
export async function startReferenceStub(): Promise<ReferenceStub> {
  const server: Server = createServer((req, res) => {
    const m = /^\/organization\/reference\/organizations\/([0-9a-f-]{36})$/.exec(req.url ?? '');
    if (req.headers.authorization !== `Bearer ${TOKEN}` || !m) {
      res.writeHead(req.headers.authorization !== `Bearer ${TOKEN}` ? 401 : 404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ organizationId: m[1], platformId: TEST_PLATFORM, companyId: TEST_COMPANY }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    env: { ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ORGANIZATION_REFERENCE_TOKEN: TOKEN },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Payment: the given caller holds every Payment operation within TEST_PLATFORM (the approved V1 policy names billing-service only). */
export const paymentPolicy = (caller = 'billing-service') => ({
  PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: { [caller]: { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] } } }),
});

const BILLING_OPERATIONS = [
  'product.create', 'product.read', 'product.archive', 'price.create', 'price.read', 'price.retire',
  'invoice.create', 'invoice.read', 'invoice.list', 'invoice.issue', 'invoice.discard',
  'payment_request.create', 'payment_request.read', 'payment_request.cancel', 'entitlement.read',
];
/** Billing: TEST-ONLY admission of a test producer (Core V1 admits no service caller to Billing). */
export const billingPolicy = (caller: string) => ({
  BILLING_SERVICE_POLICY: JSON.stringify({ callers: { [caller]: { operations: BILLING_OPERATIONS, allowedPlatforms: [TEST_PLATFORM] } } }),
});
