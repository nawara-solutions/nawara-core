import { Module } from '@nestjs/common';
import { ServiceOrUserGuard } from './service-or-user.guard.js';

@Module({
  providers: [ServiceOrUserGuard],
  exports: [ServiceOrUserGuard],
})
export class AuthModule {}
