import type { LoggerService } from '@nestjs/common';
import type { LogLevel } from '../config/base-config.js';
import { getRequestContext } from '../context/request-context.js';
import { redact, redactString } from './redact.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

/**
 * Structured JSON logging: one line per event with the service name and, inside a request, the requestId and
 * correlationId. Any structured field passes through `redact`, so credential-shaped keys never reach the log.
 * Implements Nest's LoggerService so it can be installed with `app.useLogger(...)`.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly serviceName: string,
    private readonly level: LogLevel = 'info',
    private readonly sink: LogSink = (line) => process.stdout.write(line + '\n'),
  ) {}

  private write(level: LogLevel, message: unknown, context?: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const ctx = getRequestContext();
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.serviceName,
      msg: typeof message === 'string' ? redactString(message) : redact(message),
      ...(context ? { context } : {}),
      ...(ctx ? { requestId: ctx.requestId, correlationId: ctx.correlationId } : {}),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    this.sink(JSON.stringify(line));
  }

  // Structured API for services
  debug(message: unknown, contextOrFields?: string | Record<string, unknown>) {
    this.dispatch('debug', message, contextOrFields);
  }
  info(message: unknown, contextOrFields?: string | Record<string, unknown>) {
    this.dispatch('info', message, contextOrFields);
  }

  // Nest LoggerService API
  log(message: unknown, ...rest: unknown[]) {
    this.dispatch('info', message, rest[rest.length - 1]);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.dispatch('warn', message, rest[rest.length - 1]);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.dispatch('debug', message, rest[rest.length - 1]);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.dispatch('error', message, rest[rest.length - 1]);
  }
  /** Nest calls error(message, stack?, context?). The stack goes to the log only, never to a response. */
  error(message: unknown, ...rest: unknown[]) {
    const strings = rest.filter((r): r is string => typeof r === 'string');
    const fields = rest.find((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
    const stack = strings.length > 1 ? strings[0] : undefined;
    const context = strings.length > 1 ? strings[1] : strings[0];
    this.write('error', message, context, { ...fields, ...(stack ? { stack: redactString(stack) } : {}) });
  }

  private dispatch(level: LogLevel, message: unknown, contextOrFields?: unknown) {
    if (typeof contextOrFields === 'string') this.write(level, message, contextOrFields);
    else if (contextOrFields && typeof contextOrFields === 'object') this.write(level, message, undefined, contextOrFields as Record<string, unknown>);
    else this.write(level, message);
  }
}
