import { Module } from '@nestjs/common';
import { ServiceOrUserGuard } from '@nawara/service-kit';

@Module({
  providers: [ServiceOrUserGuard],
  exports: [ServiceOrUserGuard],
})
export class AuthModule {}
