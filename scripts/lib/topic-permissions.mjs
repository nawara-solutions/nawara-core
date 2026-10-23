import ts from 'typescript';

/**
 * Core V2 S1d-1 (ADR-0057 §13.1 "S0-C5"): the catalog-driven RabbitMQ TOPIC permission generator. Pure: it reads the texts it is given
 * and returns data. It never connects to a broker, reads a credential or an environment, writes a file or runs a command, and nothing
 * consumes its output yet (the provisioning integration is S1d-2, the production rollout S1-R).
 *
 * Sources of truth (S0-C5 H1), and nothing else:
 *   - each application's `contracts/events.json`: `produces` (the events it publishes) and `consumes` (the events it binds);
 *   - the audit catalog (`libs/audit-contract/src/catalog.ts`, its `SPEC` literal): each action's ONE `producer`, routed as `audit.<action>`;
 *   - an explicit ACTIVATION manifest (S0-C5 H2) declaring, for every producer that declares domain events, whether they are `active` or
 *     `inactive` in the target environment. There is no default: a producer with domain events and no declaration, a declaration for a
 *     producer without any, or any other value fails closed.
 *
 * Per identity (the broker user of a service is its name, ADR-0053 §4) on the topic exchange `nawara.events`:
 *   write = its own active domain events + its own audit actions (`audit.<action>`), as an escaped, anchored, exact alternation;
 *   read  = the binding keys of its reviewed subscriptions: its contract's consumed event names, or the documented Audit exception below.
 * An identity with no key gets `DENY_ALL`, which matches no routing key at all (an empty pattern would match every key, and `^$` matches
 * the empty key). A consumed event never grants a publish; an audit action never grants the business event of the same name.
 *
 * Documented exceptions (each verified against the code by `checkTopicPermissionSources`):
 *   - AUDIT_READ_BINDING: audit-service binds `audit.#` (one binding for every cataloged action, `ingestion.constants.ts`). RabbitMQ checks
 *     topic READ permission against the BINDING key when a queue is bound, so its read grant is exactly that one key, `^audit\.#$`; it is a
 *     read grant only and never widens anyone's publish rights.
 *   - LOCAL_AUDIT_PRODUCERS: audit-service records its own action (`platform_query.executed`) locally and refuses it when it arrives over the
 *     bus (`producer_not_admitted`); it has no publisher. It gets no write grant for it: a grant could only carry a refused message.
 */

export const TOPIC_EXCHANGE = 'nawara.events';
export const AUDIT_ROUTING_PREFIX = 'audit.';
/** Matches no routing key (PCRE and JavaScript): the explicit deny-all. */
export const DENY_ALL = '^(?!)$';
export const AUDIT_READ_BINDING = Object.freeze({ service: 'audit-service', key: 'audit.#' });
export const LOCAL_AUDIT_PRODUCERS = Object.freeze(['audit-service']);
export const ACTIVATION_STATES = Object.freeze(['active', 'inactive']);

/** The kit's event-name grammar (`EVENT_NAME`): dotted lowercase words. Anything else is refused, not escaped into a grant. */
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,62}$/;

export class TopicPermissionError extends Error {
  constructor(message) {
    super(`topic permissions: ${message}`);
    this.name = 'TopicPermissionError';
  }
}
const fail = (message) => {
  throw new TopicPermissionError(message);
};

/** Escapes every regular-expression metacharacter (PCRE and JavaScript). */
export const escapeRegex = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** An exact alternation of `keys` (already validated), sorted, escaped and anchored; `DENY_ALL` for none. */
export function exactKeyRegex(keys) {
  if (keys.length === 0) return DENY_ALL;
  return `^(${[...keys].sort().map(escapeRegex).join('|')})$`;
}

/**
 * The audit catalog's actions and their ONE producer, from the `SPEC` object literal of `catalog.ts` (no build output: a stale `dist/` is
 * never evidence). Every entry must be `'<action>': { producer: '<service>', ... }` with literal strings; anything else (a spread, a computed
 * key, an identifier as producer) fails closed. Also returns `CORE_PRODUCERS`.
 */
export function parseAuditCatalog(text) {
  const sf = ts.createSourceFile('catalog.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let spec;
  let producers;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      let init = d.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (d.name.text === 'SPEC') spec = init;
      if (d.name.text === 'CORE_PRODUCERS') producers = init;
    }
  }
  if (!spec || !ts.isObjectLiteralExpression(spec)) fail('the audit catalog SPEC object literal was not found');
  if (!producers || !ts.isArrayLiteralExpression(producers) || !producers.elements.every(ts.isStringLiteral)) fail('the audit catalog CORE_PRODUCERS list was not found');
  const coreProducers = producers.elements.map((e) => e.text);
  const actions = [];
  for (const p of spec.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name) || !ts.isObjectLiteralExpression(p.initializer)) fail('every audit catalog entry must be a literal \'<action>\': { ... }');
    const producer = p.initializer.properties.find((q) => ts.isPropertyAssignment(q) && ts.isIdentifier(q.name) && q.name.text === 'producer');
    if (!producer || !ts.isStringLiteral(producer.initializer)) fail(`the audit action ${p.name.text} has no literal producer`);
    actions.push({ action: p.name.text, producer: producer.initializer.text });
  }
  if (actions.length === 0) fail('the audit catalog has no action');
  return { coreProducers, actions };
}

/** Validates and normalizes the activation manifest: `{ environment, domainEvents: { [service]: 'active' | 'inactive' } }`, nothing else. */
function activationOf(manifest, domainProducers) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('an activation manifest is required');
  const keys = Object.keys(manifest).sort();
  if (keys.join() !== 'domainEvents,environment') fail('the activation manifest has exactly `environment` and `domainEvents`');
  if (typeof manifest.environment !== 'string' || !ENVIRONMENT.test(manifest.environment)) fail('the activation manifest names its environment');
  const de = manifest.domainEvents;
  if (typeof de !== 'object' || de === null || Array.isArray(de)) fail('the activation manifest\'s domainEvents is an object');
  for (const [service, state] of Object.entries(de)) {
    if (!domainProducers.has(service)) fail(`the activation manifest declares ${service}, which declares no domain event`);
    if (!ACTIVATION_STATES.includes(state)) fail(`the activation state of ${service} must be active or inactive`);
  }
  for (const service of domainProducers) if (!Object.hasOwn(de, service)) fail(`the activation manifest does not declare ${service} (unknown activation fails closed)`);
  return { environment: manifest.environment, state: (service) => de[service] };
}

/**
 * The topic permissions of every broker identity.
 * `contracts`: application directory -> the text of its contracts/events.json; `auditCatalog`: the text of catalog.ts; `apps`: every
 * application directory; `activation`: the manifest. Throws a `TopicPermissionError` (never a partial result) on any invalid input.
 */
export function generateTopicPermissions({ contracts, auditCatalog, apps, activation }) {
  const appSet = new Set(apps);
  if (appSet.size === 0 || ![...appSet].every((a) => SERVICE.test(a))) fail('the application list is empty or invalid');
  const owner = new Map(); // routing key -> owning service (one owner, ever)
  const own = (key, service, why) => {
    if (owner.has(key) && owner.get(key) !== service) fail(`${key} has two owners (${owner.get(key)}, ${service})`);
    if (owner.has(key)) fail(`${key} is declared twice by ${service} (${why})`);
    owner.set(key, service);
  };
  const produced = new Map(); // service -> sorted domain event names (every declared one, active or not)
  const consumed = new Map(); // service -> sorted consumed names
  const declared = new Map(); // `${service}|${name}` -> version
  for (const app of Object.keys(contracts).sort()) {
    if (!appSet.has(app)) fail(`a contract exists for an unknown application ${app}`);
    let c;
    try {
      c = JSON.parse(contracts[app]);
    } catch {
      fail(`apps/${app}/contracts/events.json is not valid JSON`);
    }
    if (typeof c !== 'object' || c === null || c.service !== app || !Array.isArray(c.produces) || !Array.isArray(c.consumes)) fail(`apps/${app}/contracts/events.json must name its own service and list produces and consumes`);
    const names = [];
    for (const e of c.produces) {
      if (typeof e?.name !== 'string' || !EVENT_NAME.test(e.name) || !Number.isInteger(e.version) || e.version < 1) fail(`apps/${app} produces an invalid event`);
      if (e.name.startsWith(AUDIT_ROUTING_PREFIX)) fail(`apps/${app} declares ${e.name} as a domain event; audit.* keys belong to the audit catalog only`);
      own(e.name, app, 'its contract');
      declared.set(`${app}|${e.name}`, e.version);
      names.push(e.name);
    }
    produced.set(app, names.sort());
  }
  for (const app of Object.keys(contracts).sort()) {
    const names = [];
    for (const e of JSON.parse(contracts[app]).consumes) {
      if (typeof e?.source !== 'string' || typeof e?.name !== 'string' || !EVENT_NAME.test(e.name) || !Number.isInteger(e.version)) fail(`apps/${app} consumes an invalid event`);
      if (!appSet.has(e.source)) fail(`apps/${app} consumes ${e.name} from an unknown service ${e.source}`);
      if (declared.get(`${e.source}|${e.name}`) !== e.version) fail(`apps/${app} consumes ${e.source} ${e.name} v${e.version}, which ${e.source} does not declare`);
      if (e.source === app) fail(`apps/${app} consumes its own event ${e.name}`);
      if (!names.includes(e.name)) names.push(e.name);
    }
    consumed.set(app, names.sort());
  }
  const catalog = parseAuditCatalog(auditCatalog);
  for (const p of catalog.coreProducers) if (!appSet.has(p)) fail(`the audit catalog names an unknown producer ${p}`);
  const auditActions = new Map(); // service -> sorted audit routing keys
  const localOnly = new Map(); // service -> its locally recorded actions (no grant)
  for (const { action, producer } of catalog.actions) {
    if (!EVENT_NAME.test(action)) fail(`the audit action ${action} is not a valid name`);
    if (!catalog.coreProducers.includes(producer) || !appSet.has(producer)) fail(`the audit action ${action} has an unknown producer ${producer}`);
    const key = `${AUDIT_ROUTING_PREFIX}${action}`;
    own(key, producer, 'the audit catalog');
    if (LOCAL_AUDIT_PRODUCERS.includes(producer)) localOnly.set(producer, [...(localOnly.get(producer) ?? []), key].sort());
    else auditActions.set(producer, [...(auditActions.get(producer) ?? []), key].sort());
  }
  const domainProducers = new Set([...produced].filter(([, n]) => n.length > 0).map(([s]) => s));
  const act = activationOf(activation, domainProducers);
  if (!appSet.has(AUDIT_READ_BINDING.service)) fail(`the audit binding exception names an unknown service ${AUDIT_READ_BINDING.service}`);

  const identities = {};
  for (const service of [...appSet].sort()) {
    const domain = produced.get(service) ?? [];
    const state = domainProducers.has(service) ? act.state(service) : undefined;
    const writeKeys = [...(state === 'active' ? domain : []), ...(auditActions.get(service) ?? [])].sort();
    const exception = service === AUDIT_READ_BINDING.service;
    const readKeys = exception ? [AUDIT_READ_BINDING.key] : (consumed.get(service) ?? []);
    if (writeKeys.length === 0 && readKeys.length === 0) continue; // not a broker participant
    identities[service] = {
      identity: service,
      write: { keys: writeKeys, regex: exactKeyRegex(writeKeys) },
      read: { keys: [...readKeys], regex: exactKeyRegex(readKeys), ...(exception ? { bindingException: 'audit-all-actions' } : {}) },
      domainEvents: state === undefined ? 'none' : state,
      ...(state === 'inactive' ? { deniedInactive: domain } : {}),
      ...(localOnly.has(service) ? { localOnlyAuditActions: localOnly.get(service) } : {}),
    };
  }
  return { exchange: TOPIC_EXCHANGE, environment: act.environment, identities };
}

/**
 * `check:repo` (S1d-1): the current sources generate cleanly under both extreme activation states, deterministically, with no wildcard or
 * prefix grant beyond the documented Audit read binding, and the two exceptions still match the code. It never compares the generated
 * grants with `infra/rabbitmq/provision.sh` (that is S1d-2). `files`: the Audit binding constants and Audit's non-test source.
 */
export const AUDIT_BINDINGS_FILE = 'apps/audit-service/src/ingestion/ingestion.constants.ts';
export function checkTopicPermissionSources({ contracts, auditCatalog, apps, files = {}, auditSources = {} }) {
  const problems = [];
  const why = 'broker topic permissions are generated from the catalogs (ADR-0057 S0-C5)';
  for (const state of ACTIVATION_STATES) {
    let out;
    try {
      const domainEvents = {};
      for (const [app, text] of Object.entries(contracts)) {
        try {
          if (JSON.parse(text).produces?.length > 0) domainEvents[app] = state;
        } catch {
          // reported by the generator
        }
      }
      const input = { contracts, auditCatalog, apps, activation: { environment: 'check', domainEvents } };
      out = generateTopicPermissions(input);
      const reversed = generateTopicPermissions({ ...input, contracts: Object.fromEntries(Object.entries(contracts).reverse()), apps: [...apps].reverse() });
      if (JSON.stringify(out) !== JSON.stringify(reversed)) problems.push(`the generated topic permissions depend on input order; ${why}`);
    } catch (e) {
      problems.push(`${e instanceof TopicPermissionError ? e.message : 'the generator failed'}; ${why}`);
      continue;
    }
    for (const [service, id] of Object.entries(out.identities)) {
      for (const [dir, grant] of [['write', id.write], ['read', id.read]]) {
        const allowedPattern = dir === 'read' && service === AUDIT_READ_BINDING.service ? [AUDIT_READ_BINDING.key] : [];
        if (grant.keys.some((k) => !EVENT_NAME.test(k) && !allowedPattern.includes(k))) problems.push(`${service}: a ${dir} grant is not an exact event name; ${why}`);
        if (grant.regex !== exactKeyRegex(grant.keys)) problems.push(`${service}: the ${dir} regex is not the exact alternation of its keys; ${why}`);
      }
    }
  }
  const bindings = files[AUDIT_BINDINGS_FILE];
  if (bindings === undefined || !bindings.includes(`export const AUDIT_BINDINGS: readonly string[] = Object.freeze(['${AUDIT_READ_BINDING.key}']);`)) {
    problems.push(`${AUDIT_BINDINGS_FILE}: Audit's binding must be exactly ['${AUDIT_READ_BINDING.key}'], the documented read exception; ${why}`);
  }
  for (const [rel, text] of Object.entries(auditSources)) {
    if (/\b(EventsModule|OutboxRelay|OutboxService|AuditEventWriter)\b/.test(text)) problems.push(`${rel}: audit-service publishes events, but its own audit actions are generated as local-only (no grant); ${why}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 S1d-2: the provisioning representation

/**
 * S1d-2: the reviewed activation state the provisioning grants are generated for. It is a committed file (changed only by a reviewed pull
 * request), and its RESULT travels inside `infra/rabbitmq/provision.sh` (the production workflow streams that one file from `main`): no
 * runtime input, environment variable or secret can change a grant.
 */
export const PROVISION_FILE = 'infra/rabbitmq/provision.sh';
export const ACTIVATION_FILE = 'infra/rabbitmq/topic-activation.json';
export const PROVISION_ENVIRONMENT = 'production';
export const GENERATED_BEGIN = '# BEGIN GENERATED TOPIC GRANTS';
export const GENERATED_END = '# END GENERATED TOPIC GRANTS';

/**
 * The bash block of `provision.sh` for a generator output: `topic_grants_for <service>` sets TOPIC_WRITE / TOPIC_READ to the exact generated
 * regexes, and refuses (status 1) any other service. Deterministic; a regex that could break out of single quotes fails closed.
 */
export function renderProvisionTopicGrants(out) {
  const lines = [
    GENERATED_BEGIN,
    `# Generated by \`node scripts/generate-topic-grants.mjs\` from apps/*/contracts/events.json, libs/audit-contract/src/catalog.ts and`,
    `# ${ACTIVATION_FILE} (ADR-0057 S0-C5, S1d-1). Never edit by hand: \`npm run check:repo\` fails on any difference.`,
    `# environment: ${out.environment}`,
  ];
  for (const [service, id] of Object.entries(out.identities)) {
    lines.push(`# ${service}: write ${id.write.keys.length}, read ${id.read.keys.length}, domain events ${id.domainEvents}${id.read.bindingException ? `, read binding exception ${id.read.bindingException}` : ''}`);
  }
  lines.push('topic_grants_for() {', '  case "$1" in');
  for (const [service, id] of Object.entries(out.identities)) {
    for (const r of [id.write.regex, id.read.regex]) if (/['\n]/.test(r)) fail(`the ${service} grant cannot be quoted safely`);
    lines.push(`    ${service})`, `      TOPIC_WRITE='${id.write.regex}'`, `      TOPIC_READ='${id.read.regex}' ;;`);
  }
  lines.push('    *) return 1 ;;', '  esac', '}', GENERATED_END);
  return `${lines.join('\n')}\n`;
}

/** The generated block of a provisioning script text, or undefined when its markers are missing, repeated or out of order. */
export function generatedBlockOf(text) {
  const begin = text.indexOf(`${GENERATED_BEGIN}\n`);
  const end = text.indexOf(`${GENERATED_END}\n`);
  if (begin < 0 || end < begin || text.indexOf(`${GENERATED_BEGIN}\n`, begin + 1) >= 0 || text.indexOf(`${GENERATED_END}\n`, end + 1) >= 0) return undefined;
  return text.slice(begin, end + GENERATED_END.length + 1);
}

/**
 * `check:repo` (S1d-2): the grants in `provision.sh` are exactly what the generator produces from the contracts, the audit catalog and the
 * reviewed production activation file; nothing outside the generated block sets a topic grant; and every identity the script defines has
 * generated grants (and the reverse). The direction is one way: the sources generate the script, never the script the sources.
 */
export function checkProvisionTopicGrants({ contracts, auditCatalog, apps, provision, activation }) {
  const problems = [];
  const why = 'the provisioning topic grants are generated (ADR-0057 S0-C5); regenerate with `node scripts/generate-topic-grants.mjs`';
  if (provision === undefined) return [`${PROVISION_FILE} is missing; ${why}`];
  let manifest;
  try {
    manifest = JSON.parse(activation ?? '');
  } catch {
    return [`${ACTIVATION_FILE} is missing or not valid JSON; ${why}`];
  }
  if (manifest?.environment !== PROVISION_ENVIRONMENT) problems.push(`${ACTIVATION_FILE}: its environment must be ${PROVISION_ENVIRONMENT}; ${why}`);
  let expected;
  try {
    expected = renderProvisionTopicGrants(generateTopicPermissions({ contracts, auditCatalog, apps, activation: manifest }));
  } catch (e) {
    return [...problems, `${e instanceof TopicPermissionError ? e.message : 'the generator failed'}; ${why}`];
  }
  const block = generatedBlockOf(provision);
  if (block === undefined) return [...problems, `${PROVISION_FILE}: the generated topic grant block (${GENERATED_BEGIN} … ${GENERATED_END}) is missing or malformed; ${why}`];
  if (block !== expected) {
    const have = block.split('\n');
    const want = expected.split('\n');
    const at = want.findIndex((l, i) => have[i] !== l);
    problems.push(`${PROVISION_FILE}: the generated topic grants are stale or edited (first difference at block line ${at + 1}); ${why}`);
  }
  const at = provision.indexOf(block);
  const outside = provision.slice(0, at) + provision.slice(at + block.length);
  if (/\bTOPIC_(WRITE|READ)=/.test(outside)) problems.push(`${PROVISION_FILE}: a topic grant is set outside the generated block; ${why}`);
  const sets = outside.match(/set_topic_permissions[^\n]*/g) ?? [];
  if (sets.length !== 1 || !sets[0].includes('"$EXCHANGE" "$TOPIC_WRITE" "$TOPIC_READ"')) problems.push(`${PROVISION_FILE}: topic permissions must be set once, from the generated TOPIC_WRITE / TOPIC_READ; ${why}`);
  const roles = between(outside, 'permissions_for() {', '\n}\n');
  const defined = [...roles.matchAll(/^\s+([a-z][a-z0-9-]*(?:\s*\|\s*[a-z][a-z0-9-]*)*)\)/gm)].flatMap((m) => m[1].split('|').map((s) => s.trim())).sort();
  const generated = [...block.matchAll(/^ {4}([a-z][a-z0-9-]*)\)$/gm)].map((m) => m[1]).sort();
  if (JSON.stringify(defined) !== JSON.stringify(generated)) problems.push(`${PROVISION_FILE}: the identities with resource permissions (${defined.join(' ')}) must be exactly those with generated topic grants (${generated.join(' ')}); ${why}`);
  if (!/topic_grants_for "\$1" \|\| return 1/.test(roles)) problems.push(`${PROVISION_FILE}: permissions_for must take the topic grants from topic_grants_for, and refuse when there are none; ${why}`);
  return problems;
}

function between(text, start, end) {
  const at = text.indexOf(start);
  if (at < 0) return '';
  const stop = text.indexOf(end, at + start.length);
  return text.slice(at, stop < 0 ? undefined : stop);
}
