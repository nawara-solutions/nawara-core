import { BadRequestException, Controller, HttpCode, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { WebhookService } from './webhook.service.js';

@ApiTags('webhooks')
@Controller('payment/webhooks')
export class WebhooksController {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly webhooks: WebhookService,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'Provider webhook. Authenticated ONLY by the provider signature — never a service token or user bearer (SDD section 7).' })
  @ApiResponse({ status: 200, description: 'Processed, duplicate, ignored, conflict, or stored unmatched.' })
  @ApiResponse({ status: 401, description: 'webhook_signature_invalid' })
  @ApiResponse({ status: 404, description: 'unknown provider' })
  @ApiResponse({ status: 500, description: 'transient processing failure; the provider should retry' })
  async handle(@Param('provider') providerId: string, @Req() req: RawBodyRequest<Request>, @Res() res: Response): Promise<void> {
    const provider = this.providers.tryGet(providerId);
    if (!provider) throw new NotFoundException();
    // Signatures are computed over the EXACT bytes the provider sent. Never re-serialise the parsed body as a fallback: that
    // would verify (or reject) bytes nobody signed and hide a raw-body misconfiguration behind a misleading 401.
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException();
    const result = await this.webhooks.receive(provider, rawBody, req.headers);
    res.status(result.status).json(result.status === 401 ? { message: 'Unauthorized' } : { received: true });
  }
}
