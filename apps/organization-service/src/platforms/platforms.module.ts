import { Module } from '@nestjs/common';
import { PlatformsController } from './platforms.controller.js';
import { PlatformRepository } from './platform.repository.js';

@Module({ controllers: [PlatformsController], providers: [PlatformRepository] })
export class PlatformsModule {}
