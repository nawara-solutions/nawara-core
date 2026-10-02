import type { LocalizedListItem, MessageParams, MessageTexts } from '@nawara/service-kit';
import { LOCALE_SHAPE } from '../config/notification-config.js';
import { NOTIFICATION_MESSAGES as M } from '../messages.js';
import { TEMPLATE_KEY } from '../templates/catalog.js';
import { API_CHANNELS, type ApiChannel } from './caller-policy.js';

/**
 * The body of `POST /notification/notifications` (SDD §7.2), validated field by field: every field has a type and a bound, and an
 * unknown field is refused (a caller can never set a provider, a status, a category, a template version, a subject or a body). The
 * caller names a template and supplies data; the service resolves everything else. Problems name the field, never its value.
 */
export interface SendRequest {
  template: string;
  organizationId: string | null;
  recipient: { type: string; id: string } | null;
  locale: string | null;
  channels: Array<{ channel: ApiChannel; destination: string }>;
  data: Record<string, unknown>;
  scheduledAt: string | null;
  expiresAt: string | null;
}

/** `Idempotency-Key`: 8-128 characters of `[A-Za-z0-9._:-]` (SDD §7.2). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** The fields of the request (the OpenAPI schema is checked against this list). */
export const SEND_FIELDS = ['template', 'organizationId', 'recipient', 'locale', 'channels', 'data', 'scheduledAt', 'expiresAt'] as const;
const TOP = new Set<string>(SEND_FIELDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIPIENT_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));

/** A refused request: the English problems exactly as before, and, aligned with them, each one's catalog identity (ADR-0054). */
export interface SendRequestProblems {
  problems: string[];
  localized: LocalizedListItem[];
}

export function parseSendRequest(body: unknown): { value: SendRequest } | SendRequestProblems {
  const problems: string[] = [];
  const localized: LocalizedListItem[] = [];
  const problem = (english: string, texts: MessageTexts, params?: MessageParams) => {
    problems.push(english);
    localized.push({ prefix: '', message: { texts, ...(params ? { params } : {}) } });
  };
  if (!isObject(body)) {
    problem('the body must be a JSON object', M.bodyMustBeObject);
    return { problems, localized };
  }
  for (const k of Object.keys(body)) if (!TOP.has(k)) problem(`${k.slice(0, 40)}: is not a field of this request`, M.notAField, { name: k.slice(0, 40) });
  if (typeof body.template !== 'string' || !TEMPLATE_KEY.test(body.template) || body.template.length > 128) problem('template: must be a template key', M.templateKey);
  if (body.organizationId !== undefined && body.organizationId !== null && !(typeof body.organizationId === 'string' && UUID.test(body.organizationId))) {
    problem('organizationId: must be a uuid or null', M.organizationId);
  }
  if (body.recipient !== undefined && body.recipient !== null) {
    const r = body.recipient;
    if (!isObject(r) || Object.keys(r).some((k) => k !== 'type' && k !== 'id') || typeof r.type !== 'string' || !RECIPIENT_TYPE.test(r.type)
      || typeof r.id !== 'string' || r.id.length < 1 || r.id.length > 128) {
      problem('recipient: must be {"type", "id"} (a lowercase type, an id of 1-128 characters)', M.recipient);
    }
  }
  if (body.locale !== undefined && body.locale !== null && !(typeof body.locale === 'string' && LOCALE_SHAPE.test(body.locale) && body.locale.length <= 35)) {
    problem('locale: must be a BCP 47 locale', M.locale);
  }
  if (!Array.isArray(body.channels) || body.channels.length < 1 || body.channels.length > API_CHANNELS.length) {
    problem(`channels: must list 1-${API_CHANNELS.length} channels`, M.channelsCount, { max: API_CHANNELS.length });
  } else {
    body.channels.forEach((c, i) => {
      if (!isObject(c) || Object.keys(c).some((k) => k !== 'channel' && k !== 'destination') || !(API_CHANNELS as readonly unknown[]).includes(c.channel)
        || typeof c.destination !== 'string' || c.destination.length < 1 || c.destination.length > 320) {
        problem(`channels[${i}]: must be {"channel": ${API_CHANNELS.join(' | ')}, "destination": a string of 1-320 characters}`, M.channelItem, { index: i, channels: API_CHANNELS.join(' | ') });
      }
    });
  }
  if (body.data !== undefined && !isObject(body.data)) problem('data: must be an object', M.dataObject);
  if (body.scheduledAt !== undefined && body.scheduledAt !== null && !isInstant(body.scheduledAt)) problem('scheduledAt: must be an ISO 8601 UTC date-time', M.utcDateTime, { field: 'scheduledAt' });
  if (body.expiresAt !== undefined && body.expiresAt !== null && !isInstant(body.expiresAt)) problem('expiresAt: must be an ISO 8601 UTC date-time', M.utcDateTime, { field: 'expiresAt' });
  if (problems.length > 0) return { problems, localized };
  return {
    value: {
      template: body.template as string,
      organizationId: (body.organizationId as string | null | undefined) ?? null,
      recipient: (body.recipient as { type: string; id: string } | null | undefined) ?? null,
      locale: (body.locale as string | null | undefined) ?? null,
      channels: body.channels as SendRequest['channels'],
      data: (body.data as Record<string, unknown> | undefined) ?? {},
      scheduledAt: (body.scheduledAt as string | null | undefined) ?? null,
      expiresAt: (body.expiresAt as string | null | undefined) ?? null,
    },
  };
}
