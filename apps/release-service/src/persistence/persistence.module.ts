import { Module } from '@nestjs/common';
import { ReleaseStore } from './release-store.js';

/** Stage 20.2: the Release Management persistence primitives (the kit DbModule is global). No HTTP surface uses them yet. */
@Module({ providers: [ReleaseStore], exports: [ReleaseStore] })
export class PersistenceModule {}
