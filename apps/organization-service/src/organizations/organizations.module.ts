import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationRepository } from './organization.repository.js';

@Module({ controllers: [OrganizationsController], providers: [OrganizationRepository] })
export class OrganizationsModule {}
