import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { getRequestContext } from '../context/request-context.js';
import type { JsonLogger } from '../logging/json-logger.js';

export interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  code?: string;
  requestId?: string;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 409: 'Conflict', 411: 'Length Required',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

function codeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const code = (raw as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isClientHttpError(e: unknown): e is { status?: number; statusCode?: number } {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { status?: unknown; statusCode?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
  return typeof code === 'number' && code >= 400 && code < 500;
}

/**
 * One error shape for every Core service: Nest's `{ statusCode, message, error }` plus `requestId`.
 * A stable, machine-readable `code` is additive and optional: throw `new HttpException({ message, code }, status)`
 * and it passes through untouched; omit it and the body is unchanged from before.
 * Anything that is not an HttpException (database errors, bugs, provider failures) becomes an opaque 500: the real error
 * goes to the server log only. No stack, SQL text, constraint name or credential can reach a response.
 */
@Catch()
export class KitExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = getRequestContext()?.requestId;
    let body: ErrorBody;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message = typeof raw === 'string' ? raw : ((raw as { message?: string | string[] }).message ?? exception.message);
      const code = codeOf(raw);
      body = { statusCode: status, message, error: STATUS_TEXT[status] ?? 'Error', ...(code ? { code } : {}), requestId };
      if (status >= 500) this.logger.error('request failed', { status, error: exception.constructor.name });
    } else if (isClientHttpError(exception)) {
      // Errors raised by Express middleware (for example body-parser: payload too large, malformed JSON) carry an HTTP status.
      // The status is honoured; the message is generic, because these messages can echo fragments of the request.
      const status = exception.status ?? exception.statusCode ?? 400;
      body = { statusCode: status, message: STATUS_TEXT[status] ?? 'Bad Request', error: STATUS_TEXT[status] ?? 'Bad Request', requestId };
    } else {
      body = { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error', error: 'Internal Server Error', requestId };
      this.logger.error('unhandled error', { error: exception instanceof Error ? exception.name : typeof exception, detail: exception instanceof Error ? exception.message : undefined });
    }
    if (!res.headersSent) res.status(body.statusCode).json(body);
  }
}
