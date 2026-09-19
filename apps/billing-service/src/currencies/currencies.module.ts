import { Module } from '@nestjs/common';
import { PlatformCurrencyRepository } from './platform-currency.repository.js';

/** Platform-level currency configuration persistence. No controller: the administrative API is not approved (B-036). */
@Module({ providers: [PlatformCurrencyRepository], exports: [PlatformCurrencyRepository] })
export class CurrenciesModule {}
