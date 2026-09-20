import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller.js';

@Module({ controllers: [ReferenceController] })
export class ReferenceModule {}
