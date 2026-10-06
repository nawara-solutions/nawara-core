import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../config/base-config.js';
import { getRequestContext } from '../context/request-context.js';
import { MAX_STRING, safeSerialize, scrubText, stackFrames } from './safe-serialize.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

/**
 * V2 A12.4: fields the logger owns. A caller field with one of these names is dropped (its NAME is listed in `droppedFields`, never its
 * value): the logger's level, service, time, message, request ids and stack cannot be forged by a caller.
 */
export const LOG_ENVELOPE_FIELDS = ['ts', 'level', 'service', 'msg', 'context', 'requestId', 'correlationId', 'stack', 'droppedFields', 'fieldsTruncated'] as const;
/** Compared case- and separator-insensitively, so `Level`, `SERVICE` or `request_id` cannot pose as the envelope in a case-folding query. */
const reservedKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const RESERVED: ReadonlySet<string> = new Set(LOG_ENVELOPE_FIELDS.map(reservedKey));
/** One log line at most this long: past it, the caller's fields are replaced by `fieldsTruncated: true` (the envelope and msg stay). */
export const MAX_RECORD_LENGTH = 16 * 1024;
const MAX_CONTEXT = 128;
/** What a line says when its record could not be built at all. */
export const UNSERIALIZABLE_RECORD = 'log_record_unserializable';

/**
 * Structured JSON logging: one line per event with the service name and, inside a request, the requestId and correlationId.
 * Implements Nest's LoggerService so it can be installed with `app.useLogger(...)`.
 *
 * V2 A12.4: logging never changes the caller's control flow. Every entry point is total: a value that cannot be serialized becomes a
 * placeholder (`safeSerialize`), a record that cannot be built becomes a minimal `log_record_unserializable` line, and a failing sink is
 * ignored. Secrets and direct PII are redacted by key, free text is scrubbed (`scrubText`), an Error is its facts, never its message, and
 * a stack is its frames only (owner decision W1).
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly serviceName: string,
    private readonly level: LogLevel = 'info',
    private readonly sink: LogSink = (line) => process.stdout.write(line + '\n'),
  ) {}

  private write(level: LogLevel, message: unknown, context?: unknown, fields?: unknown, stack?: unknown): void {
    try {
      if (ORDER[level] < ORDER[this.level]) return;
      this.emit(this.record(level, message, context, fields, stack));
    } catch {
      try {
        this.emit(JSON.stringify({ ts: new Date().toISOString(), level, service: this.serviceName, msg: UNSERIALIZABLE_RECORD }));
      } catch {
        // Nothing more can be done without risking the caller.
      }
    }
  }

  private emit(line: string): void {
    try {
      this.sink(line);
    } catch {
      // A failing sink (a closed stdout, a throwing test sink) never reaches the caller.
    }
  }

  private record(level: LogLevel, message: unknown, context: unknown, fields: unknown, stack: unknown): string {
    const ctx = getRequestContext();
    const envelope: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.serviceName,
      msg: typeof message === 'string' ? scrubText(message, MAX_STRING) : (safeSerialize(message) ?? null),
      ...(typeof context === 'string' && context ? { context: scrubText(context, MAX_CONTEXT) } : {}),
      ...(ctx ? { requestId: ctx.requestId, correlationId: ctx.correlationId } : {}),
    };
    const extra: Record<string, unknown> = Object.create(null) as Record<string, unknown>; // a `__proto__` key stays data
    const dropped: string[] = [];
    if (fields !== undefined) {
      const serialized = safeSerialize(fields);
      const own = serialized !== null && typeof serialized === 'object' && !Array.isArray(serialized) ? serialized : { fields: serialized };
      for (const [k, v] of Object.entries(own)) {
        if (RESERVED.has(reservedKey(k))) dropped.push(k);
        else extra[k] = v;
      }
    }
    const frames = stackFrames(stack);
    const tail = { ...(frames ? { stack: frames } : {}), ...(dropped.length > 0 ? { droppedFields: dropped } : {}) };
    const line = JSON.stringify({ ...envelope, ...extra, ...tail });
    return line.length <= MAX_RECORD_LENGTH ? line : JSON.stringify({ ...envelope, fieldsTruncated: true });
  }

  // Structured API for services
  debug(message: unknown, contextOrFields?: string | Record<string, unknown>) {
    this.dispatch('debug', message, [contextOrFields]);
  }
  info(message: unknown, contextOrFields?: string | Record<string, unknown>) {
    this.dispatch('info', message, [contextOrFields]);
  }

  // Nest LoggerService API. A Nest `Logger` appends its context name AFTER the caller's parameters, so `new Logger('X').warn(msg, fields)`
  // arrives as (msg, fields, 'X'): the context is the last string, the fields the first object (V2 A12.4.3).
  log(message: unknown, ...rest: unknown[]) {
    this.dispatch('info', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.dispatch('warn', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.dispatch('debug', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.dispatch('error', message, rest);
  }
  /** Nest calls error(message, stack?, context?). The stack's frames go to the log only, never to a response, and never its message. */
  error(message: unknown, ...rest: unknown[]) {
    try {
      const strings = rest.filter((r): r is string => typeof r === 'string');
      const fields = rest.find((r) => typeof r === 'object' && r !== null);
      const stack = strings.length > 1 ? strings[0] : undefined;
      const context = strings.length > 1 ? strings[1] : strings[0];
      this.write('error', message, context, fields, stack);
    } catch {
      this.write('error', UNSERIALIZABLE_RECORD);
    }
  }

  private dispatch(level: LogLevel, message: unknown, rest: unknown[]) {
    try {
      const strings = rest.filter((r): r is string => typeof r === 'string');
      const fields = rest.find((r) => typeof r === 'object' && r !== null);
      this.write(level, message, strings[strings.length - 1], fields);
    } catch {
      this.write(level, UNSERIALIZABLE_RECORD);
    }
  }
}
