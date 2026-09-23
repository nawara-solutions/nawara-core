#!/usr/bin/env node
// Stage 15.4 crash-relay (test-only child): the kit's OutboxRelay on a bus whose publish never returns, so the relay's claiming
// transaction holds its batch's row locks. Prints `claimed <n>` once it is stuck inside the transaction; the parent SIGKILLs it and
// checks that PostgreSQL releases the locks and another relay recovers the rows.
import { DbService, OutboxRelay } from '../../../libs/service-kit/dist/index.js';

const db = new DbService({ url: process.env.DATABASE_URL, applicationName: 'validation-crash-relay' });
let announced = false;
const stuckBus = {
  publish: () => {
    if (!announced) {
      announced = true;
      process.stdout.write('claimed\n');
    }
    return new Promise(() => undefined);
  },
  subscribe: async () => ({ close: async () => undefined }),
  close: async () => undefined,
};
await new OutboxRelay(db, stuckBus, { source: 'validation', batchSize: Number(process.env.BATCH ?? 50) }).drainOnce();
