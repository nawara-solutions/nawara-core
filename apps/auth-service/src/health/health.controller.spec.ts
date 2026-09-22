import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { DbService } from '../db/db.service.js';
import { HealthController } from './health.controller.js';

const fakeRes = () => {
  const status = vi.fn();
  return { res: { status } as unknown as Response, status };
};

describe('HealthController', () => {
  it('returns ok when the database answers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const ctrl = new HealthController({ query } as unknown as DbService);
    const { res, status } = fakeRes();
    await expect(ctrl.health(res)).resolves.toEqual({ status: 'ok' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(status).not.toHaveBeenCalled();
  });

  it('returns 503 without leaking the cause when the database is down', async () => {
    const query = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const ctrl = new HealthController({ query } as unknown as DbService);
    const { res, status } = fakeRes();
    const body = await ctrl.health(res);
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });
});
