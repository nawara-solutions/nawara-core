// The production ORDER (ADR-0053 §5) as machine-checkable facts rather than tribal knowledge:
//   broker (infra/rabbitmq/provision.sh) -> audit-service (declares and binds audit-service.audit) -> auth-service (relay may publish).
// The runtime proofs are in auth-deploy.test.mjs (the guard refuses) and real-broker.mjs (the hazard is real); these static checks keep
// the scripts and the runbook from drifting away from that order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SCRIPTS } from './lib/harness.mjs';

const read = (p) => readFileSync(p, 'utf8');
/** Offset of the first line that changes something on the server (container, network, volume or database). */
function firstMutation(text) {
  const lines = text.split('\n');
  const k = lines.findIndex((l) => !l.trimStart().startsWith('#') && /\bdocker (run|stop|rename|rm|network (create|connect))\b|\bpsql_stdin\b.*<|\| psql_stdin/.test(l));
  return lines.slice(0, k).join('\n').length;
}

test('Auth: the audit-binding guard runs before the first mutating command', () => {
  const auth = read(SCRIPTS.auth);
  const guard = auth.indexOf("grep -qxF \"$BIND_EXPECTED\"");
  assert.ok(guard > 0, 'the ordering guard exists');
  assert.ok(guard < firstMutation(auth), 'the guard must precede every docker run / stop / network change / psql');
  assert.match(auth, /BIND_EXPECTED=\$\(printf 'nawara\.events\\taudit-service\.audit\\taudit\.#'\)/, 'it checks the exact canonical binding');
});

test('Audit: the deploy only succeeds after verifying the binding Auth checks, on the broker', () => {
  const audit = read(SCRIPTS.audit);
  assert.match(audit, /grep -qxF "nawara\.events\$\{T\}\$\{QUEUE\}\$\{T\}audit\.#"/);
  assert.match(audit, /^QUEUE=audit-service\.audit$/m);
});

test('the queue and binding the scripts check are the ones audit-service declares (ingestion.constants.ts)', () => {
  const constants = read(join(ROOT, 'apps/audit-service/src/ingestion/ingestion.constants.ts'));
  assert.match(constants, /AUDIT_EXCHANGE = 'nawara\.events'/);
  assert.match(constants, /AUDIT_QUEUE = 'audit-service\.audit'/);
  assert.match(constants, /AUDIT_BINDINGS: readonly string\[\] = Object\.freeze\(\['audit\.#'\]\)/);
});

test('no script carries a default or fallback broker credential', () => {
  for (const [name, p] of Object.entries(SCRIPTS)) {
    const text = read(p);
    assert.doesNotMatch(text, /guest:guest|amqp:\/\/[a-z-]+:[^@$%]+@/i, `${name} must never embed a broker credential`);
  }
  assert.doesNotMatch(read(SCRIPTS.auth), /RABBITMQ_URL:-[^}]/, 'Auth has no non-empty default RABBITMQ_URL (`${RABBITMQ_URL:-}` only tests whether it is set)');
});

test('the runbook states the same order: provision the broker, deploy audit-service, then auth-service', () => {
  const runbook = read(join(ROOT, 'docs/runbooks/core-rabbitmq-production.md'));
  const at = (s) => { const i = runbook.indexOf(s); assert.ok(i >= 0, `runbook mentions ${s}`); return i; };
  assert.ok(at('core-rabbitmq-provision.yml') < at('audit-service-deploy.yml'));
  assert.ok(at('audit-service-deploy.yml') < at('auth-service-deploy.yml'));
});
