import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * A test stand-in for Auth's receipt routes (AUTH-02, AUTH-03; Core V2 S2-Auth.2), over real HTTP so Payment's own client is exercised. It
 * follows Auth's contract (`apps/auth-service/src/receipts/authorization-receipt.service.ts`): exact binding equality, consumption idempotent
 * on `consumeRef` for the same caller, `consume_ref_conflict`, `receipt_invalid` for a voided or unknown receipt, `receipt_expired`,
 * `authority_revoked` leaving the receipt issued, and a lookup that answers only the caller's consumption for that reference and binding.
 * Test controls inject failures (`unavailable`, `loseResponse`). Never production code.
 */
export interface FakeReceipt {
  id: string;
  secret: string;
  binding: Record<string, unknown>;
  issuer: string;
  status: 'issued' | 'consumed' | 'voided';
  expired: boolean;
  consumeRef?: string;
  consumedAt?: string;
}

export interface FakeReceiptServer {
  url: string;
  token: string;
  receipts: Map<string, FakeReceipt>;
  calls: { consume: number; lookup: number };
  /** owners whose authority Auth would refuse now (`authority_revoked`) */
  revoked: Set<string>;
  /** the next N consume calls answer 503 receipt_outcome_unknown WITHOUT consuming */
  unavailable: { consume: number; lookup: number };
  /** the next N consume calls consume, then answer 503 (the response is "lost") */
  loseResponse: { consume: number };
  issue(binding: Record<string, unknown>, issuer?: string): FakeReceipt;
  close(): Promise<void>;
}

const canonical = (v: Record<string, unknown>) => JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));

export async function startFakeReceiptServer(): Promise<FakeReceiptServer> {
  const token = randomBytes(24).toString('hex');
  const receipts = new Map<string, FakeReceipt>();
  const state: FakeReceiptServer = {
    url: '', token, receipts, calls: { consume: 0, lookup: 0 }, revoked: new Set(), unavailable: { consume: 0, lookup: 0 }, loseResponse: { consume: 0 },
    issue(binding, issuer = randomUUID()) {
      const r: FakeReceipt = { id: randomUUID(), secret: randomBytes(32).toString('base64url'), binding: { legalOverride: false, ...binding }, issuer, status: 'issued', expired: false };
      receipts.set(r.secret, r);
      return r;
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const wire = (r: FakeReceipt) => ({ receiptId: r.id, consumeRef: r.consumeRef, consumedAt: r.consumedAt, approvedBy: { userId: r.issuer }, companyId: r.binding.companyId });
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { code: 'unauthorized' });
      const body = JSON.parse(raw || '{}') as { secret?: string; binding?: Record<string, unknown>; consumeRef?: string };
      const binding: Record<string, unknown> = { legalOverride: false, ...body.binding };
      if (binding.audience !== 'payment-service') return send(400, { code: 'receipt_binding_invalid' });
      if (req.url === '/auth/service/authorization-receipts/consume') {
        state.calls.consume++;
        if (state.unavailable.consume > 0) {
          state.unavailable.consume--;
          return send(503, { code: 'receipt_outcome_unknown' });
        }
        const r = receipts.get(body.secret ?? '');
        if (!r || canonical(r.binding) !== canonical(binding) || r.status === 'voided') return send(409, { code: 'receipt_invalid' });
        if (r.status === 'consumed') return r.consumeRef === body.consumeRef ? send(200, wire(r)) : send(409, { code: 'consume_ref_conflict' });
        if ([...receipts.values()].some((o) => o.consumeRef === body.consumeRef)) return send(409, { code: 'consume_ref_conflict' });
        if (r.expired) return send(409, { code: 'receipt_expired' });
        if (state.revoked.has(r.issuer)) return send(403, { code: 'authority_revoked' });
        r.status = 'consumed';
        r.consumeRef = body.consumeRef;
        r.consumedAt = new Date().toISOString();
        if (state.loseResponse.consume > 0) {
          state.loseResponse.consume--;
          return send(503, { code: 'receipt_outcome_unknown' });
        }
        return send(200, wire(r));
      }
      if (req.url === '/auth/service/authorization-receipts/consumptions/lookup') {
        state.calls.lookup++;
        if (state.unavailable.lookup > 0) {
          state.unavailable.lookup--;
          return send(503, { code: 'receipt_unavailable' });
        }
        const r = [...receipts.values()].find((o) => o.status === 'consumed' && o.consumeRef === body.consumeRef && canonical(o.binding) === canonical(binding));
        return r ? send(200, wire(r)) : send(404, { code: 'not_found' });
      }
      return send(404, { code: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  state.url = `http://127.0.0.1:${addr.port}`;
  return state;
}
