// Core V2 S1d-2 (ADR-0057 S0-C5): regenerates the topic grant block of infra/rabbitmq/provision.sh from the event contracts, the audit
// catalog and the reviewed activation file (infra/rabbitmq/topic-activation.json). Local files only: no broker, no credential, no network.
// `node scripts/generate-topic-grants.mjs` rewrites the block; `--check` only reports whether it is current (exit 1 when it is not).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVATION_FILE, PROVISION_FILE, generateTopicPermissions, generatedBlockOf, renderProvisionTopicGrants } from './lib/topic-permissions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const apps = readdirSync(join(root, 'apps')).filter((a) => statSync(join(root, 'apps', a)).isDirectory());
const contracts = Object.fromEntries(apps.filter((a) => existsSync(join(root, 'apps', a, 'contracts/events.json'))).map((a) => [a, readFileSync(join(root, 'apps', a, 'contracts/events.json'), 'utf8')]));
const block = renderProvisionTopicGrants(generateTopicPermissions({
  contracts, apps, auditCatalog: readFileSync(join(root, 'libs/audit-contract/src/catalog.ts'), 'utf8'),
  activation: JSON.parse(readFileSync(join(root, ACTIVATION_FILE), 'utf8')),
}));
const file = join(root, PROVISION_FILE);
const text = readFileSync(file, 'utf8');
const current = generatedBlockOf(text);
if (current === undefined) {
  console.error(`${PROVISION_FILE}: the generated block markers are missing or malformed; nothing was written`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log(current === block ? 'topic grants: current' : 'topic grants: STALE');
  process.exit(current === block ? 0 : 1);
}
// spliced by index: a String.replace replacement would interpret `$'` (which every deny-all grant ends with) as a pattern
const at = text.indexOf(current);
if (current !== block) writeFileSync(file, text.slice(0, at) + block + text.slice(at + current.length));
console.log(current === block ? 'topic grants: already current' : `topic grants: ${PROVISION_FILE} updated`);
