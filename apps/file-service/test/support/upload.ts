import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** A test service policy covering the Stage 17.5 cases. */
export const UPLOAD_POLICY = {
  callers: {
    'core-drive': { operations: ['upload', 'read', 'attach', 'issue_ticket'], organizations: 'request', mediaTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'], maxBytes: 25 * 1024 * 1024 },
    'core-billing': { operations: ['upload', 'attach'], organizations: 'none', mediaTypes: ['application/pdf'], maxBytes: 1024 * 1024 },
    'core-reader': { operations: ['read'], organizations: 'none' },
  },
};

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: () => Record<string, unknown>;
}

/**
 * A raw HTTP request against a LISTENING application, for what supertest cannot express: a streamed body, no Content-Length (chunked),
 * a lying Content-Length, a client that stops mid-body or disappears.
 */
export function rawRequest(
  app: NestExpressApplication,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: Buffer | Readable; stallAfter?: number; abortAfter?: number },
): Promise<RawResponse | 'socket_closed'> {
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) as Record<string, unknown> });
      });
      res.on('error', () => resolve('socket_closed'));
    });
    req.on('error', () => resolve('socket_closed'));
    const body = opts.body;
    if (body === undefined) return void req.end();
    if (!Buffer.isBuffer(body)) return void body.pipe(req);
    if (opts.abortAfter !== undefined) {
      req.write(body.subarray(0, opts.abortAfter));
      setTimeout(() => req.destroy(), 100);
      return;
    }
    if (opts.stallAfter !== undefined) {
      req.write(body.subarray(0, opts.stallAfter)); // …and never another byte, never the end
      return;
    }
    req.end(body);
  });
}

/** Resolves once `check` holds (a settled row after a disconnect), polling briefly. */
export async function eventually<T>(check: () => Promise<T | undefined>, ms = 8_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 50));
  }
}
