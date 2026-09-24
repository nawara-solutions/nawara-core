import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { S3Storage, type S3StorageOptions } from '../../src/storage/s3-storage.js';

/** The S3-compatible TEST server (any implementation of the protocol; CI runs VersityGW). Test infrastructure, not a provider choice. */
export interface TestS3Env {
  TEST_S3_ENDPOINT: string;
  TEST_S3_ACCESS_KEY_ID: string;
  TEST_S3_SECRET_ACCESS_KEY: string;
}
export const TEST_S3_VARS = ['TEST_S3_ENDPOINT', 'TEST_S3_ACCESS_KEY_ID', 'TEST_S3_SECRET_ACCESS_KEY'];

export function s3Options(env: TestS3Env, bucket: string, over: Partial<S3StorageOptions> = {}): S3StorageOptions {
  return {
    endpoint: env.TEST_S3_ENDPOINT, region: 'us-east-1', bucket, accessKeyId: env.TEST_S3_ACCESS_KEY_ID, secretAccessKey: env.TEST_S3_SECRET_ACCESS_KEY,
    forcePathStyle: true, connectTimeoutMs: 2_000, idleTimeoutMs: 30_000, requestTimeoutMs: 10_000, minThroughputBytesPerSecond: 65_536, maxAttempts: 3, ...over,
  };
}

/**
 * A throwaway bucket per suite, created and emptied by the TEST harness (the service never creates or deletes buckets: provisioning is
 * operational, SDD §4).
 */
export async function withTestBucket(env: TestS3Env): Promise<{ bucket: string; admin: S3Client; drop: () => Promise<void> }> {
  const admin = new S3Client({ endpoint: env.TEST_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: env.TEST_S3_ACCESS_KEY_ID, secretAccessKey: env.TEST_S3_SECRET_ACCESS_KEY } });
  const bucket = `file-test-${randomBytes(6).toString('hex')}`;
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  return {
    bucket,
    admin,
    async drop() {
      for (;;) {
        const page = await admin.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (!page.Contents?.length) break;
        for (const o of page.Contents) await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key! }));
      }
      await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
      admin.destroy();
    },
  };
}

export const s3Storage = (env: TestS3Env, bucket: string, over: Partial<S3StorageOptions> = {}) => new S3Storage(s3Options(env, bucket, over));
