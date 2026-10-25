import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ServiceOperationGuard, ServiceTokenGuard } from '@nawara/service-kit';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthorizationReceiptController, ServiceAuthorizationReceiptController } from './authorization-receipt.controller.js';

/** Core V2 S2-Auth.2: exactly three receipt routes, each behind the right authentication and authorization (D-A2 §5, §11.2). */
const meta = (key: string, target: object) => Reflect.getMetadata(key, target) as unknown;
/** A route handler, read from the prototype without detaching a method. */
const handler = (cls: { prototype: object }, name: string) => Object.getOwnPropertyDescriptor(cls.prototype, name)!.value as object;

describe('authorization receipt routes (S2-Auth.2)', () => {
  it('AUTH-01 is POST /auth/admin/authorization-receipts, owners only, through the bearer AuthGuard', () => {
    const issue = handler(AuthorizationReceiptController, 'issue');
    expect(meta(PATH_METADATA, AuthorizationReceiptController)).toBe('auth/admin/authorization-receipts');
    expect([meta(PATH_METADATA, issue), meta(METHOD_METADATA, issue)]).toEqual(['/', RequestMethod.POST]);
    expect(meta(GUARDS_METADATA, issue)).toEqual([AuthGuard]);
    expect(meta('actor_kinds', issue)).toEqual(['owner']);
  });

  it('AUTH-02 and AUTH-03 are service-token routes, each requiring its own policy operation', () => {
    const c = ServiceAuthorizationReceiptController;
    expect(meta(PATH_METADATA, c)).toBe('auth/service/authorization-receipts');
    // class-level: authentication of the SERVICE first, then its operation (no user bearer, no header identity)
    expect(meta(GUARDS_METADATA, c)).toEqual([ServiceTokenGuard, ServiceOperationGuard]);
    const routes = [
      [handler(c, 'consume'), 'consume', 'authorization_receipt.consume'],
      [handler(c, 'lookup'), 'consumptions/lookup', 'authorization_receipt.lookup'],
    ] as const;
    for (const [h, path, op] of routes) {
      expect([meta(PATH_METADATA, h), meta(METHOD_METADATA, h), meta('nawara:service-operation', h)]).toEqual([path, RequestMethod.POST, op]);
      expect(meta(GUARDS_METADATA, h)).toBeUndefined(); // nothing route-level that could replace the class guards
    }
  });

  it('no other controller references the receipt service or names a receipt route', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== 'receipts') walk(path); continue; }
        if (!name.endsWith('.ts') || name.endsWith('.spec.ts') || name === 'app.module.ts') continue;
        if (/AuthorizationReceiptService|authorization-receipts/.test(readFileSync(path, 'utf8'))) hits.push(path.slice(src.length));
      }
    };
    walk(src);
    expect(hits).toEqual([]);
  });
});
