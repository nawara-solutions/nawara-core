import { describe, expect, it } from 'vitest';
import { SECRET_FIELD_NAME, formatDeadLetter, outputToken, type DeadLetterInfo } from '../src/events/dlq-tools.js';

const info = (over: Partial<DeadLetterInfo> = {}): DeadLetterInfo => ({
  position: 1, eventId: 'e-1', eventName: 'payment.cancelled', correlationId: 'corr-1', failure: 'permanent', failureReason: 'invalid_identifier',
  failureError: 'PermanentEventFailure', retryCount: 0, replayCount: 0, failedAt: '2026-01-01T00:00:00.000Z', bodyRedacted: false, fields: {}, ...over,
});

describe('nawara-dlq output', () => {
  it('reduces publisher-controlled header values to printable, single-token, bounded text', () => {
    expect(outputToken('a b\tc\nd')).toBe('a_b_c_d');
    expect(outputToken('\u001b[31mred\u001b[0m')).toBe('_[31mred_[0m'); // no terminal escape sequence survives
    expect(outputToken('é')).toBe('_');
    expect(outputToken('x'.repeat(1000))).toHaveLength(128);
    expect(outputToken(null)).toBe('-');
    expect(outputToken(undefined)).toBe('-');
  });

  it('a hostile correlation id or event id cannot forge a second line or a second field', () => {
    const line = formatDeadLetter(info({ correlationId: 'x\ndlq_message position=9 event=forged', eventId: 'id extra=1' }));
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('correlationId=x_dlq_message_position=9_event=forged');
    expect(line).toContain('event=id_extra=1 ');
  });

  it('shows only the fixed columns plus the payload fields that were asked for by name', () => {
    const line = formatDeadLetter(info({ fields: { paymentRequestId: 'req-1' } }));
    expect(line).toBe('dlq_message position=1 event=e-1 name=payment.cancelled correlationId=corr-1 classification=permanent reason=invalid_identifier error=PermanentEventFailure retries=0 replays=0 failedAt=2026-01-01T00:00:00.000Z paymentRequestId=req-1');
  });

  it('Stage 21.C.2: names that mark a secret are redacted whatever the operator asks for (one-time codes never reach the output)', () => {
    for (const n of ['code', 'otp', 'pin', 'secret', 'secretKey', 'token', 'accessToken', 'password', 'ciphertext', 'apiKey', 'login_code', 'confirmation-code']) {
      expect(SECRET_FIELD_NAME.test(n)).toBe(true);
    }
    for (const n of ['paymentRequestId', 'userId', 'eventName', 'channel', 'expiresAt', 'organizationId', 'failureCodeClass']) {
      expect(SECRET_FIELD_NAME.test(n)).toBe(false);
    }
  });
});
