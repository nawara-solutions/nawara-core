import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { DbService } from '../db/db.service.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns ok when the database answers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const ctrl = new HealthController({ query } as unknown as DbService);
    await expect(ctrl.health()).resolves.toEqual({ status: 'ok' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 without leaking the cause when the database is down', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const ctrl = new HealthController({ query } as unknown as DbService);
    const err = await ctrl.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((err as ServiceUnavailableException).getResponse())).not.toContain('ECONNREFUSED');
  });
});
