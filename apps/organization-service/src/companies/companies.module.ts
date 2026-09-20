import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller.js';
import { CompanyRepository } from './company.repository.js';

@Module({ controllers: [CompaniesController], providers: [CompanyRepository] })
export class CompaniesModule {}
