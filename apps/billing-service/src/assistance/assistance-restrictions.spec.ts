import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BillingExceptionFilter } from '../errors/billing-exception.filter.js';
import { RESERVED_RESTRICTION_KINDS, RESTRICTION_KINDS, assistanceRestricted } from './assistance-restrictions.js';

const since = new Date('2026-10-01T00:00:00Z');

describe('Core V2 S5d restriction error (S5D-4)', () => {
  it('409 assistance_restricted with every kind once, in order, and the compatible singular first kind; nothing else', () => {
    const e = assistanceRestricted([
      { kind: 'T1', sourceId: 'a', since }, { kind: 'T1', sourceId: 'b', since }, { kind: 'T2', sourceId: 'c', since },
    ]);
    expect(e.getStatus()).toBe(409);
    const body = e.getResponse() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'assistance_restricted', restriction: 'T1', restrictions: ['T1', 'T2'] });
    expect(JSON.stringify(body)).not.toMatch(/"a"|"b"|"c"|sourceId|since/); // kinds only, never a source
  });

  it('T1, T2 and (Core V2 S6f) T3 are produced; inactive stays reserved', () => {
    expect([...RESTRICTION_KINDS]).toEqual(['T1', 'T2', 'T3']);
    expect([...RESERVED_RESTRICTION_KINDS]).toEqual(['inactive']);
  });
});

describe('BillingExceptionFilter', () => {
  const extra = (raw: unknown) => (new BillingExceptionFilter({} as never) as unknown as { extraResponseFields(r: unknown): Record<string, unknown> }).extraResponseFields(raw);

  it('passes through only the documented restriction fields, verbatim', () => {
    expect(extra({ message: 'm', code: 'assistance_restricted', restriction: 'T1', restrictions: ['T1'], sourceId: 'x', amount: 1 })).toEqual({ restriction: 'T1', restrictions: ['T1'] });
    expect(extra(new HttpException({ message: 'm' }, 400).getResponse())).toEqual({});
    expect(extra('text')).toEqual({});
    expect(extra(null)).toEqual({});
  });
});
