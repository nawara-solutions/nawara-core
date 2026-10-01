import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestContext } from '../context/request-context.js';
import { renderMessage, type MessageTexts } from '../i18n/catalog.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale.js';
import { describeFailure } from '../logging/failure.js';
import type { JsonLogger } from '../logging/json-logger.js';
import { localizedMessageListOf, localizedMessageOf } from './http-error.js';
import { KIT_MESSAGES, statusMessage } from './kit-messages.js';

export interface ErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  code?: string;
  requestId?: string;
}

/** ADR-0054 behaviour of the filter. Off by default (Auth's subclass is unchanged until it adopts it, R5); `configureApp` turns it on. */
export interface KitExceptionFilterOptions {
  /**
   * Localize `message` (D5) and add the `Content-Language` / `Vary` headers (D8). It never adds or changes a public `code`: a response
   * carries a code only when its thrower supplied one (a code-less error stays code-less until its path is adopted, R4 to R6).
   */
  localize?: boolean;
  /**
   * Path prefixes whose error responses keep exactly the pre-ADR-0054 rendering: no new code, no localization, no new header (D12,
   * for example a payment provider's webhook route). Prefix match on the request path.
   */
  excludedPathPrefixes?: readonly string[];
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

/** Appends `Accept-Language` to `Vary`, keeping every existing value (CORS varies on `Origin`) and never duplicating it. */
function varyOnAcceptLanguage(res: Response): void {
  const current = res.getHeader('Vary');
  const values = (Array.isArray(current) ? current.join(',') : current === undefined ? '' : String(current))
    .split(',').map((v) => v.trim()).filter(Boolean);
  if (values.includes('*') || values.some((v) => v.toLowerCase() === 'accept-language')) return;
  res.setHeader('Vary', [...values, 'Accept-Language'].join(', '));
}

/**
 * One error shape for every Core service: Nest's `{ statusCode, message, error }` plus `requestId`.
 * A stable, machine-readable `code` is additive and optional: throw `httpError(status, code, message)` (or
 * `new HttpException({ message, code }, status)`) and it passes through untouched; omit it and the body is unchanged from before.
 * Anything that is not an HttpException (database errors, bugs, provider failures) becomes an opaque 500. No stack, SQL text,
 * constraint name or credential can reach a response. The server log gets the failure's facts only (`describeFailure`: class,
 * SQLSTATE or system code, failure kind; the request and correlation ids come from the logger's context), never its message: a
 * message can name internal hosts and paths, carry SQL or constraint text, echo user input or hold a secret (Stage 22 F13).
 *
 * With `localize` (ADR-0054), classification happens FIRST and only these become localized text: a catalog message a Core thrower
 * attached through `httpError`, a Nest exception's default status text, a middleware client error's generic text, and the opaque 500.
 * Any other message is a Core-written English string and passes through unchanged; nothing of an unexpected error is ever rendered.
 * The message identity used for that is internal: it never becomes the public `code`, which is emitted exactly as the thrower set it.
 */
@Catch()
export class KitExceptionFilter implements ExceptionFilter {
  private readonly localize: boolean;
  private readonly excludedPathPrefixes: readonly string[];

  constructor(private readonly logger: JsonLogger, options: KitExceptionFilterOptions = {}) {
    this.localize = options.localize ?? false;
    this.excludedPathPrefixes = options.excludedPathPrefixes ?? [];
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request | undefined>();
    const requestId = getRequestContext()?.requestId;
    const localize = this.localize && !this.isExcluded(req);
    const locale: Locale = localize ? (getRequestContext()?.locale ?? DEFAULT_LOCALE) : DEFAULT_LOCALE;
    let used: string = DEFAULT_LOCALE; // the Content-Language value: one language, or `<locale>, en` for a partly translated list
    const render = (texts: MessageTexts, params?: Parameters<typeof renderMessage>[2]): string => {
      const r = renderMessage(texts, locale, params);
      used = r.locale;
      return r.text;
    };
    let body: ErrorBody;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      let message = typeof raw === 'string' ? raw : ((raw as { message?: string | string[] }).message ?? exception.message);
      const code = codeOf(raw);
      if (localize) {
        const attached = localizedMessageOf(exception);
        const list = localizedMessageListOf(exception);
        const generic = statusMessage(status);
        if (attached) message = render(attached.texts, attached.params);
        else if (list && Array.isArray(message) && list.length === message.length) {
          // a validation list (R4): each element rendered in place, same array, same order; an unidentified element stays English
          const english = message;
          const langs = new Set<Locale>();
          message = english.map((text, i) => {
            const item = list[i];
            if (!item) return (langs.add(DEFAULT_LOCALE), text);
            const r = renderMessage(item.message.texts, locale, item.message.params);
            langs.add(r.locale);
            return `${item.prefix}${r.text}`;
          });
          used = langs.size <= 1 ? ([...langs][0] ?? DEFAULT_LOCALE) : [locale, DEFAULT_LOCALE].join(', ');
        }
        else if (generic && message === STATUS_TEXT[status]) {
          // the message IS the status phrase (a Nest exception's default message, or a Core thrower that used it): a framework constant,
          // never caller data. Localized text only: the code stays exactly what the thrower set, or absent.
          message = render(generic);
        }
      }
      body = { statusCode: status, message, error: STATUS_TEXT[status] ?? 'Error', ...(code ? { code } : {}), requestId };
      if (status >= 500) this.logger.error('request failed', { status, error: exception.constructor.name });
    } else if (isClientHttpError(exception)) {
      // Errors raised by Express middleware (for example body-parser: payload too large, malformed JSON) carry an HTTP status.
      // The status is honoured; the message is generic, because these messages can echo fragments of the request.
      const status = exception.status ?? exception.statusCode ?? 400;
      const text = STATUS_TEXT[status] ?? 'Bad Request';
      const message = localize ? render(statusMessage(status) ?? KIT_MESSAGES.status_400) : text;
      body = { statusCode: status, message, error: text, requestId };
    } else {
      const message = localize ? render(KIT_MESSAGES.internal_failure) : 'Internal server error';
      body = { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message, error: 'Internal Server Error', requestId };
      this.logger.error('unhandled error', { failure: describeFailure(exception) });
    }
    if (res.headersSent) return;
    if (localize) {
      res.setHeader('Content-Language', used);
      varyOnAcceptLanguage(res);
    }
    res.status(body.statusCode).json(body);
  }

  private isExcluded(req: Request | undefined): boolean {
    if (this.excludedPathPrefixes.length === 0 || !req) return false;
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
    return this.excludedPathPrefixes.some((p) => path.startsWith(p));
  }
}
