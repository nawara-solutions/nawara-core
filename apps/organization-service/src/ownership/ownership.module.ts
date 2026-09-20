import { Global, Module } from '@nestjs/common';
import { OwnershipService } from './ownership.service.js';

@Global()
@Module({ providers: [OwnershipService], exports: [OwnershipService] })
export class OwnershipModule {}
