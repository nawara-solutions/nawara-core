import { HttpException } from '@nestjs/common';
import type { LocalizedMessage, MessageParams, MessageTexts } from '../i18n/catalog.js';
import { renderMessage } from '../i18n/catalog.js';
import { DEFAULT_LOCALE } from '../i18n/locale.js';

// The message identity rides on the exception object under a module-private symbol: never in its response object, so it can never
// reach a response body (Auth's filter copies extra RESPONSE fields; a symbol is not one of them).
const LOCALIZED = Symbol('nawara.localizedMessage');

/** Attaches a catalog message to an exception the kit or a service throws deliberately (D10: only those are ever localized). */
export function attachLocalizedMessage<E extends HttpException>(exception: E, message: LocalizedMessage): E {
  Object.defineProperty(exception, LOCALIZED, { value: Object.freeze({ ...message }), enumerable: false });
  return exception;
}

export function localizedMessageOf(exception: HttpException): LocalizedMessage | undefined {
  return (exception as unknown as Record<symbol, LocalizedMessage | undefined>)[LOCALIZED];
}

/**
 * ADR-0054: the shared way to throw a public Core API error. The body is the existing `{ message, code }` (the filter adds
 * `statusCode`, `error` and `requestId`); `code` is the stable machine contract.
 *   - `message` as catalog texts: the `en` text is the body by default (byte-for-byte English, D6) and the filter renders the
 *     negotiated language; `params` fill `{name}` placeholders and must be safe, service-computed values (D10).
 *   - `message` as a plain string: English only, exactly as before (a service not yet adopted, R5/R6).
 */
export function httpError(status: number, code: string, message: string | MessageTexts, params?: MessageParams): HttpException {
  if (typeof message === 'string') return new HttpException({ message, code }, status);
  const english = renderMessage(message, DEFAULT_LOCALE, params).text;
  return attachLocalizedMessage(new HttpException({ message: english, code }, status), { texts: message, ...(params ? { params } : {}) });
}
