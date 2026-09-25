import { createHash, randomBytes } from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { S3Storage } from '../src/storage/s3-storage.js';
import { describeWithEnv } from './support/env.js';
import { s3Storage, TEST_S3_VARS, withTestBucket, type TestS3Env } from './support/s3.js';
import { bodyOf, code, generated, newKey, peakBufferGrowth, sig, storageContract } from './support/storage-contract.js';

/**
 * Stage 17.4: the S3-compatible adapter against a real S3 protocol server (a throwaway bucket on the test server; CI runs VersityGW):
 * the SAME StoragePort contract as the filesystem adapter, then what only S3 can get wrong.
 */
describeWithEnv('S3-compatible storage (real S3 protocol server)', TEST_S3_VARS, (raw) => {
  const env = raw as unknown as TestS3Env;
  let bucket: string;
  let drop: () => Promise<void>;
  let admin: Awaited<ReturnType<typeof withTestBucket>>['admin'];
  let storage: S3Storage;
  let shortDeadline: S3Storage;
  const consoleSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
  beforeAll(async () => {
    ({ bucket, drop, admin } = await withTestBucket(env));
    storage = s3Storage(env, bucket);
    shortDeadline = s3Storage(env, bucket, { requestTimeoutMs: 1_000, minThroughputBytesPerSecond: 1_024 });
  });
  afterAll(async () => {
    storage?.close();
    shortDeadline?.close();
    await drop?.();
  });

  storageContract(() => ({ storage, shortDeadline }));

  it('stores exactly under the key it is given (no derived path, no prefix of its own), with the transport content type', async () => {
    const key = newKey();
    await storage.put(key, bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'image/webp', signal: sig() });
    const h = await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(h.ContentLength).toBe(10);
    expect(h.ContentType).toBe('image/webp');
    expect(h.Metadata ?? {}).toEqual({}); // no owner, organization, name or lifecycle in object metadata: PostgreSQL is the authority
  });

  it('objects are private: an anonymous request cannot read one (no ACL is ever sent)', async () => {
    const key = newKey();
    await storage.put(key, bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'application/pdf', signal: sig() });
    const anonymous = await fetch(`${env.TEST_S3_ENDPOINT}/${bucket}/${key}`);
    expect([401, 403]).toContain(anonymous.status);
    const listing = await fetch(`${env.TEST_S3_ENDPOINT}/${bucket}`);
    expect([401, 403]).toContain(listing.status);
  });

  it('wrong credentials are `storage_rejected`; a missing bucket too (operator faults), with no bucket or endpoint in the error', async () => {
    const wrong = s3Storage({ ...env, TEST_S3_SECRET_ACCESS_KEY: 'definitely-not-the-secret-000' }, bucket);
    const noBucket = s3Storage(env, `missing-${randomBytes(4).toString('hex')}`);
    try {
      for (const e of [await wrong.head(newKey(), { signal: sig() }).catch((x: unknown) => x), await noBucket.get(newKey(), { signal: sig() }).catch((x: unknown) => x),
        await noBucket.put(newKey(), bodyOf(randomBytes(4)), { sizeBytes: 4, contentType: 'x', signal: sig() }).catch((x: unknown) => x)]) {
        expect(code(e)).toBe('storage_rejected');
        const visible = `${String(e)} ${JSON.stringify(e)}`;
        for (const leak of [bucket, 'missing-', new URL(env.TEST_S3_ENDPOINT).host, 'definitely-not']) expect(visible).not.toContain(leak);
      }
    } finally {
      wrong.close();
      noBucket.close();
    }
  });

  it('large stream: 48 MiB streamed in and out (one PUT, no buffering of the object, exact digest)', async () => {
    const size = 48 * 1024 * 1024;
    const key = newKey();
    const src = generated(size);
    const inGrowth = await peakBufferGrowth(() => storage.put(key, src.body, { sizeBytes: size, contentType: 'application/pdf', signal: sig() }));
    let outDigest = '';
    const outGrowth = await peakBufferGrowth(async () => {
      const got = await storage.get(key, { signal: sig() });
      const h = createHash('sha256');
      for await (const c of got.body) h.update(c as Buffer);
      outDigest = h.digest('hex');
    });
    expect(outDigest).toBe(src.digest());
    // Relative to the object: a buffering implementation holds ≥ 1 × size; fast sampling in one process is noisy (up to ~20 MiB seen).
    expect(inGrowth).toBeLessThan(0.75 * size);
    expect(outGrowth).toBeLessThan(0.75 * size);
  }, 120_000);

  it('the SDK never writes to the console (its messages would bypass the JSON logs)', () => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
