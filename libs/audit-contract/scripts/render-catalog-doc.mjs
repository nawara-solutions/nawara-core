// Writes docs/architecture/audit-event-catalog.md from the BUILT catalog (run through `npm run catalog:doc`, which builds first).
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCatalogDocument } from '../dist/catalog-doc.js';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/architecture/audit-event-catalog.md');
writeFileSync(target, renderCatalogDocument());
console.log(`wrote ${target}`);
