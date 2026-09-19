import { DynamicModule, Global, Module } from '@nestjs/common';
import { DB_OPTIONS, DbService, type DbOptions } from './db.service.js';

@Global()
@Module({})
export class DbModule {
  static forRoot(options: DbOptions): DynamicModule {
    return {
      module: DbModule,
      providers: [{ provide: DB_OPTIONS, useValue: options }, DbService],
      exports: [DbService, DB_OPTIONS],
    };
  }
}
