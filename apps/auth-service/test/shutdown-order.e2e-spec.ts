import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { describeFailure } from '@nawara/service-kit';
import { DbService } from '../src/db/db.service.js';
import { createTestApp } from './helpers/app.js';

/**
 * Stage 15.5 (F-C): Auth closed its database pool in `onModuleDestroy`, the FIRST hook Nest runs on shutdown, while its HTTP server still
 * admitted requests (Nest closes HTTP only after every `beforeApplicationShutdown`). Work still legitimately running during the drain,
 * such as a request admitted before shutdown started, then failed on a closed pool. The probe queries the database from
 * `beforeApplicationShutdown`, which runs during that window: the pool must still be open there, and closed once shutdown completes.
 */
let db: DbService | undefined;
const seen: string[] = [];

@Injectable()
class ShutdownProbe implements BeforeApplicationShutdown {
  async beforeApplicationShutdown(): Promise<void> {
    try {
      await db!.query('SELECT 1');
      seen.push('ok');
    } catch (e) {
      seen.push(describeFailure(e));
    }
  }
}

describe('Auth shutdown order (Stage 15.5, F-C)', () => {
  it('the database pool is still usable while shutdown drains, and closed once it has completed', async () => {
    const t = await createTestApp({}, { providers: [ShutdownProbe] });
    db = t.app.get(DbService);
    await t.close();
    expect(seen).toEqual(['ok']);
    await expect(db.query('SELECT 1')).rejects.toThrow(); // closed by onApplicationShutdown
  });
});
