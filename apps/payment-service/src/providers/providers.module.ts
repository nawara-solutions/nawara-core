import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider-registry.js';
import { SimulationPaymentProvider } from './simulation-provider.js';
import { TestPaymentProvider } from './test-provider.js';

/** Global: attempts, sync and (later) webhooks all need ProviderRegistry. */
@Global()
@Module({
  providers: [TestPaymentProvider, SimulationPaymentProvider, ProviderRegistry],
  exports: [ProviderRegistry, TestPaymentProvider, SimulationPaymentProvider],
})
export class ProvidersModule {}
