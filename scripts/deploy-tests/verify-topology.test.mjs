// Core V2 OD-BRK-2a: infra/rabbitmq/verify-topology.sh against a docker stand-in that replays AUTHENTIC RabbitMQ 3.13.7 `rabbitmqctl`
// output (captured from rabbitmq:3.13.7-alpine with Notification's queues declared exactly as the kit declares them, the probe's
// administrator renamed to nawara-admin). The live proof is scripts/deploy-tests/real-broker-notification-topology.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VERIFIER = join(ROOT, 'infra/rabbitmq/verify-topology.sh');
const PROVISION = join(ROOT, 'infra/rabbitmq/provision.sh');
const T = '\t';
const READ = '^(auth\\.user_registered)$';
const ROLE = {
  conf: '^(nawara\\.events|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
  write: '^(amq\\.default|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$',
};
const RETRY_TEXT = '[{"x-dead-letter-exchange",[]},{"x-dead-letter-routing-key","notification.events"}]';
const RETRY_TYPED = '[["x-dead-letter-exchange","longstr",""],["x-dead-letter-routing-key","longstr","notification.events"]]';
const textRow = (name, args, policy = '', opPolicy = '', effective = '[]') => [name, 'true', 'classic', args, policy, opPolicy, effective].join(T);
const typedListing = (records) => `[\n${records.map((r, i) => `${i ? ',' : ''}${r}`).join('\n')}\n]\n`;
const typed = (name, args) => `{"name":"${name}","arguments":${args}}`;

/** The clean post-grant world, as `rabbitmqctl -q ... --no-table-headers` (and `--formatter json`) prints it. */
const CLEAN = {
  list_users: `notification-service${T}[]\nnawara-admin${T}[administrator]\n`,
  list_permissions: `notification-service${T}${ROLE.conf}${T}${ROLE.write}${T}${ROLE.conf}\nnawara-admin${T}.*${T}.*${T}.*\n`,
  list_topic_permissions: `notification-service${T}nawara.events${T}^(?!)$${T}${READ}\n`,
  list_policies: '\n',
  list_operator_policies: '\n',
  list_exchanges: [`amq.direct${T}direct${T}true${T}false${T}[]${T}`, `nawara.events${T}topic${T}true${T}false${T}[]${T}`, `${T}direct${T}true${T}false${T}[]${T}`].join('\n') + '\n',
  list_queues: [textRow('notification.events', '[]'), textRow('notification.events.retry', RETRY_TEXT), textRow('notification.events.dead', '[]')].join('\n') + '\n',
  'list_queues.json': typedListing([typed('notification.events', '[]'), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.dead', '[]')]),
  list_bindings: [`${T}notification.events${T}queue${T}notification.events`, `${T}notification.events.retry${T}queue${T}notification.events.retry`, `${T}notification.events.dead${T}queue${T}notification.events.dead`, `nawara.events${T}notification.events${T}queue${T}auth.user_registered`].join('\n') + '\n',
  list_consumers: '',
  list_channels: '',
  list_parameters: '\n',
  plugins: 'rabbitmq_federation\nrabbitmq_management_agent\nrabbitmq_prometheus\nrabbitmq_web_dispatch\n',
};

/** A docker stand-in: `exec ... rabbitmqctl -q <sub> ...` prints fixtures/<sub>[.json]; `<key>.exit` makes that listing fail. */
const SHIM = `#!/usr/bin/env bash
[ "$1" = exec ] || exit 9
shift; while [ "$1" = -u ]; do shift 2; done; shift
tool=$1; shift
case "$tool" in
  rabbitmq-diagnostics) exit 0 ;;
  rabbitmq-plugins) key=plugins ;;
  rabbitmqctl) [ "$1" = -q ] && shift; key=$1; [[ " $* " == *" --formatter json "* ]] && key="$key.json" ;;
  *) exit 9 ;;
esac
[ -f "$FIXTURES/$key.exit" ] && exit "$(cat "$FIXTURES/$key.exit")"
cat "$FIXTURES/$key"
`;

/** Runs the standalone (or the provision-embedded) verifier post-grant over CLEAN + `over` (a key -> output; `null` = that listing fails). */
const verify = (over = {}, { phase = 'post-grant', script = VERIFIER } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-topology-'));
  try {
    writeFileSync(join(dir, 'docker'), SHIM);
    chmodSync(join(dir, 'docker'), 0o755);
    for (const [k, v] of Object.entries({ ...CLEAN, ...over })) {
      if (v === null) writeFileSync(join(dir, `${k}.exit`), '1');
      else writeFileSync(join(dir, k), v);
    }
    const r = spawnSync('bash', [script, 'notification-service', '--phase', phase], {
      env: { PATH: `${dir}:${process.env.PATH}`, FIXTURES: dir, NOTIFICATION_CONTAINMENT_STATE: join(dir, 'no-latch'), EXPECTED_TOPIC_WRITE: '^(?!)$', EXPECTED_TOPIC_READ: READ },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const json = JSON.parse(r.stdout.trim().split('\n').pop());
    json.exit = r.status;
    json.status = (id) => json.checks.find((c) => c.id === id)?.status;
    return json;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
/** The embedded copy, as provisioning runs it (`verify_topology` reads it from its heredoc). */
const embedded = () => {
  const s = readFileSync(PROVISION, 'utf8');
  const start = "<<'NAWARA_TOPOLOGY_VERIFIER'\n";
  const a = s.indexOf(start) + start.length;
  return s.slice(a, s.indexOf('\nNAWARA_TOPOLOGY_VERIFIER\n', a));
};

test('the LEGITIMATE retry queue (3.13.7 prints its empty default exchange as `[]`; typed: longstr "") passes; only the latch is missing', () => {
  assert.match(CLEAN.list_queues, /x-dead-letter-exchange",\[\]\}/, 'the authentic text rendering');
  const v = verify();
  for (const id of ['Q1', 'Q2', 'Q3', 'B1', 'C1', 'U1', 'U2', 'P1', 'P2', 'P3', 'X1', 'A1', 'A2', 'R1']) assert.equal(v.status(id), 'PASS', id);
  assert.equal(v.status('L1'), 'UNKNOWN', 'no root-owned latch here');
  assert.equal(v.status('Q0'), undefined);
  assert.equal(v.result, 'UNKNOWN', 'an unverifiable latch alone keeps the result UNKNOWN, never PASS');
  assert.equal(v.exit, 3);
  assert.equal(v.completeness, 'full');
});

test('an unexpected retry topology FAILS Q2: a named dead-letter exchange, another routing key, an extra argument, a policy', () => {
  const variants = {
    'the shared fanout': ['[["x-dead-letter-exchange","longstr","nawara.events.dlx"],["x-dead-letter-routing-key","longstr","notification.events"]]'],
    'another exchange': ['[["x-dead-letter-exchange","longstr","amq.direct"],["x-dead-letter-routing-key","longstr","notification.events"]]'],
    'another routing key': ['[["x-dead-letter-exchange","longstr",""],["x-dead-letter-routing-key","longstr","other.queue"]]'],
    'an empty routing key': ['[["x-dead-letter-exchange","longstr",""],["x-dead-letter-routing-key","longstr",""]]'],
    'no routing key': ['[["x-dead-letter-exchange","longstr",""]]'],
    'no argument at all': ['[]'],
    'an extra TTL': ['[["x-dead-letter-exchange","longstr",""],["x-dead-letter-routing-key","longstr","notification.events"],["x-message-ttl","short",1000]]'],
    'a non-string exchange value': ['[["x-dead-letter-exchange","array",[]],["x-dead-letter-routing-key","longstr","notification.events"]]'],
    'a regular policy applied': [RETRY_TYPED, textRow('notification.events.retry', RETRY_TEXT, 'p1', '', '[{<<"dead-letter-exchange">>,<<"nawara.events.dlx">>}]')],
    'an operator policy applied': [RETRY_TYPED, textRow('notification.events.retry', RETRY_TEXT, '', 'op1', '[{<<"message-ttl">>,1}]')],
    'not durable': [RETRY_TYPED, textRow('notification.events.retry', RETRY_TEXT).replace(`${T}true${T}`, `${T}false${T}`)],
    'a quorum queue': [RETRY_TYPED, textRow('notification.events.retry', RETRY_TEXT).replace(`${T}classic${T}`, `${T}quorum${T}`)],
  };
  for (const [what, [args, row]] of Object.entries(variants)) {
    const over = { 'list_queues.json': typedListing([typed('notification.events', '[]'), typed('notification.events.retry', args), typed('notification.events.dead', '[]')]) };
    if (row) over.list_queues = [textRow('notification.events', '[]'), row, textRow('notification.events.dead', '[]')].join('\n') + '\n';
    const v = verify(over);
    assert.equal(v.status('Q2'), 'FAIL', what);
    assert.equal(v.result, 'FAIL', what);
    assert.equal(v.exit, 1, what);
    assert.equal(v.status('Q1'), 'PASS', `${what}: the work queue is judged on its own`);
  }
});

test('the work and private dead queues stay strict: any argument (a broker dead-letter exchange, a TTL) FAILS them', () => {
  const dlx = '[["x-dead-letter-exchange","longstr","nawara.events.dlx"]]';
  const work = verify({ 'list_queues.json': typedListing([typed('notification.events', dlx), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.dead', '[]')]) });
  assert.equal(work.status('Q1'), 'FAIL');
  assert.equal(work.status('Q2'), 'PASS');
  const ttl = '[["x-message-ttl","short",1]]';
  const dead = verify({ 'list_queues.json': typedListing([typed('notification.events', '[]'), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.dead', ttl)]) });
  assert.equal(dead.status('Q3'), 'FAIL');
  // the retry queue's arguments on the work queue are not "the empty exchange": the work queue may have none
  const swapped = verify({ 'list_queues.json': typedListing([typed('notification.events', RETRY_TYPED), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.dead', '[]')]) });
  assert.equal(swapped.status('Q1'), 'FAIL');
});

test('missing, malformed or unparseable queue listings are UNKNOWN (never PASS): nothing is established', () => {
  const retryless = typedListing([typed('notification.events', '[]'), typed('notification.events.dead', '[]')]);
  const cases = {
    'the typed record is missing while the queue is listed': { 'list_queues.json': retryless },
    'the typed record appears twice': { 'list_queues.json': typedListing([typed('notification.events', '[]'), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.retry', RETRY_TYPED), typed('notification.events.dead', '[]')]) },
    'the typed listing is not the 3.13.7 shape': { 'list_queues.json': 'Error: unexpected\n' },
    'the text row has too few columns': { list_queues: [textRow('notification.events', '[]'), ['notification.events.retry', 'true', 'classic', RETRY_TEXT].join(T), textRow('notification.events.dead', '[]')].join('\n') + '\n' },
    'the text row is missing while the typed record exists': { list_queues: [textRow('notification.events', '[]'), textRow('notification.events.dead', '[]')].join('\n') + '\n' },
  };
  for (const [what, over] of Object.entries(cases)) {
    const v = verify(over);
    assert.notEqual(v.status('Q2'), 'PASS', what);
    assert.equal(v.status('Q2'), 'UNKNOWN', what);
    assert.notEqual(v.result, 'PASS', what);
    assert.equal(v.exit, 3, `${what}: UNKNOWN exits 3`);
  }
  // either listing failing: every queue-derived check is UNKNOWN
  for (const key of ['list_queues', 'list_queues.json']) {
    const v = verify({ [key]: null });
    for (const id of ['Q1', 'Q2', 'Q3', 'B1', 'C1']) assert.equal(v.status(id), 'UNKNOWN', `${key} failing: ${id}`);
    assert.equal(v.exit, 3);
  }
});

test('UNKNOWN is fail-closed: it never becomes PASS, and a FAIL anywhere dominates it', () => {
  const unknown = verify({ 'list_queues.json': 'garbage\n' });
  assert.equal(unknown.result, 'UNKNOWN');
  const both = verify({ 'list_queues.json': 'garbage\n', list_policies: `nawara-core${T}p1${T}^notification\\.${T}queues${T}{"dead-letter-exchange":"x"}${T}0\n` });
  assert.equal(both.status('P1'), 'FAIL');
  assert.equal(both.result, 'FAIL');
  assert.equal(both.exit, 1);
  // before creation, absent queues are NOT_APPLICABLE (pre_creation), never PASS
  const pre = verify({ list_queues: '', 'list_queues.json': '[\n]\n', list_bindings: '' }, { phase: 'post-grant' });
  for (const id of ['Q1', 'Q2', 'Q3']) assert.equal(pre.status(id), 'NOT_APPLICABLE_PRE_CREATION', id);
  assert.equal(pre.completeness, 'pre_creation');
});

test('the verifier embedded in provision.sh IS the standalone one, and both judge the same world identically', () => {
  assert.equal(embedded(), readFileSync(VERIFIER, 'utf8').replace(/\n$/, ''));
  const dir = mkdtempSync(join(tmpdir(), 'verify-embedded-'));
  try {
    const copy = join(dir, 'embedded.sh');
    writeFileSync(copy, embedded());
    for (const over of [{}, { 'list_queues.json': 'garbage\n' }, { 'list_queues.json': typedListing([typed('notification.events', '[]'), typed('notification.events.retry', '[]'), typed('notification.events.dead', '[]')]) }]) {
      const a = verify(over);
      const b = verify(over, { script: copy });
      assert.deepEqual([b.result, b.exit, b.checks], [a.result, a.exit, a.checks]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
