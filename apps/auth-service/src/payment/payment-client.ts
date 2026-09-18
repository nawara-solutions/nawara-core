import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/**
 * Auth's ONLY dependency on payment-service (ADR-0004 as narrowed by ADR-0026): a yes/no question
 * asked at REGISTRATION about whether an organization holds a valid license. Login and refresh never
 * call this. Auth stores no answer, caches none, and never treats it as authentication state.
 */
export interface PaymentClient {
  isOrganizationLicensed(organizationId: string): Promise<boolean>;
}
export const PAYMENT_CLIENT = Symbol('PAYMENT_CLIENT');

@Injectable()
export class HttpPaymentClient implements PaymentClient {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Fail CLOSED: any error, timeout or non-2xx other than a definitive "no license" is a 503. */
  async isOrganizationLicensed(organizationId: string): Promise<boolean> {
    if (!this.cfg.payment.baseUrl) throw new ServiceUnavailableException();
    try {
      const res = await fetch(`${this.cfg.payment.baseUrl}/payment/licenses/${encodeURIComponent(organizationId)}/status`, {
        headers: { authorization: `Bearer ${this.cfg.payment.serviceToken}` }, // service-to-service credential
        signal: AbortSignal.timeout(this.cfg.payment.timeoutMs),
      });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { valid?: boolean };
      return body.valid === true;
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
