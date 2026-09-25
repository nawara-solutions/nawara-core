import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * HTTP Basic auth for the Swagger UI. Both fields are compared in constant time (via fixed-length
 * digests) so neither the username nor the password length/prefix leaks through timing.
 */
export function basicAuth(username: string, password: string) {
  const wantUser = digest(username);
  const wantPass = digest(password);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme?.toLowerCase() === 'basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0) {
        // Evaluate both comparisons unconditionally.
        const userOk = timingSafeEqual(digest(decoded.slice(0, i)), wantUser);
        const passOk = timingSafeEqual(digest(decoded.slice(i + 1)), wantPass);
        if (userOk && passOk) return next();
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="audit-service docs", charset="UTF-8"');
    res.status(401).send('Unauthorized');
  };
}
