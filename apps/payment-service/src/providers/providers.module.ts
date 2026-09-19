import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider-registry.js';
import { TestPaymentProvider } from './test-provider.js';

/** Global: attempts, sync and (later) webhooks all need ProviderRegistry. */
@Global()
@Module({
  providers: [TestPaymentProvider, ProviderRegistry],
  exports: [ProviderRegistry, TestPaymentProvider],
})
export class ProvidersModule {}
