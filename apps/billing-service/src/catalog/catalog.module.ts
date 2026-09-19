import { Module } from '@nestjs/common';
import { PriceRepository } from './price.repository.js';
import { PricesController } from './prices.controller.js';
import { ProductRepository } from './product.repository.js';
import { ProductsController } from './products.controller.js';

/** The catalog: products and their immutable prices (SDD sections 11, 12, 18.1 endpoints 1-6). Service-token only. */
@Module({
  controllers: [ProductsController, PricesController],
  providers: [ProductRepository, PriceRepository],
  exports: [ProductRepository, PriceRepository],
})
export class CatalogModule {}
