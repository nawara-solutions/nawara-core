import { Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AssistanceOwner, AssistanceOwnerGuard } from '../assistance/assistance-owner.guard.js';
import type { VerifiedAssistanceOwner } from '../assistance/assistance-resolution.service.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundOwner, RefundOwnerGuard, type VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { representReview, StalledWorkService } from './stalled-work.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => billingError(400, 'invalid_stalled_work_request', BILLING_MESSAGES.invalidStalledWorkRequest);
const R401 = { status: 401, description: 'no bearer, a bearer Auth refuses, or a SERVICE token (never forwarded to Auth)' };
const R403 = { status: 403, description: 'operation_not_permitted: not an Owner' };
const R503 = { status: 503, description: 'auth_timeout | auth_unavailable' };
const ITEMS = 'Each item: {id, kind, subjectId, observedState, reason, anchorAt, thresholdSeconds, sendAttempts, paymentRequestId, platformId, organizationId, '
  + 'escalatedAt, exit: null | {state, observedAt}}. REVIEW EVIDENCE ONLY: an item closes, retries, releases, changes and assigns nothing, and there is no action on it.';

function page(after: string | undefined, limit: string | undefined): { after: string | null; limit: number } {
  const n = limit === undefined ? 100 : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 200 || (after !== undefined && !UUID.test(after))) throw invalid();
  return { after: after ?? null, limit: n };
}

/**
 * Core V2 G3 (DO-41, DO-42): the Company Owner's read of their Company's stalled payment requests and payment-event conflicts. The Owner of the seller
 * Company, with their OWN bearer verified live (`RefundOwnerGuard`), and each item's Platform verified live (an item with no single Platform is the
 * Company's). Never a Billing-internal item (auth_fault, an untrusted conflict: their scope is NULL). DEVELOPMENT AND SIMULATION ONLY.
 */
@ApiTags('stalled-work')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(RefundOwnerGuard)
export class StalledWorkController {
  constructor(
    private readonly stalled: StalledWorkService,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Get('stalled-work')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "G3 (DO-41, DO-42): the Owner's Company's stalled-work review items for payment requests (keyset by id); read-only." })
  @ApiQuery({ name: 'after', required: false, description: 'the last id of the previous page' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: `{ items }. ${ITEMS}` })
  @ApiResponse({ status: 400, description: 'invalid_stalled_work_request' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse(R503)
  async list(@RefundOwner() owner: VerifiedRefundOwner, @Query('after') after?: string, @Query('limit') limit?: string) {
    if (this.config.isProduction) throw notFound();
    const p = page(after, limit);
    const rows = await this.stalled.listForCompany(owner.companyId, p.after, p.limit);
    const visible = [];
    for (const r of rows) {
      if (r.platformId === null || (await this.owners.platformAllowed(owner.bearer, r.platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) visible.push(r);
    }
    return { items: visible.map(representReview) };
  }
}

/**
 * Core V2 G3 (DO-31, DO-33): the Platform Owner's read of one Platform's stalled assistance items, under S5c's existing authority: an Owner (live,
 * `AssistanceOwnerGuard`) whose access to THAT Platform Auth confirms live (`/auth/platform-access`); any other Platform is 404 (one answer). No
 * step-up: it only reads. Mounted only where assistance is (never in production).
 */
@ApiTags('stalled-work')
@ApiBearerAuth()
@Controller('billing/admin')
@UseGuards(AssistanceOwnerGuard)
export class AssistanceStalledWorkController {
  constructor(
    private readonly stalled: StalledWorkService,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  @Get('assistance-stalled-work')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: "G3 (DO-31, DO-33): one Platform's stalled assistance review items (open J-1 disputes, uncertain settlement channels), keyset by id; read-only." })
  @ApiQuery({ name: 'platformId', required: true })
  @ApiQuery({ name: 'after', required: false, description: 'the last id of the previous page' })
  @ApiQuery({ name: 'limit', required: false, description: '1 to 200 (default 100)' })
  @ApiResponse({ status: 200, description: `{ items }. ${ITEMS}` })
  @ApiResponse({ status: 400, description: 'invalid_stalled_work_request' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  @ApiResponse({ status: 404, description: 'not_found: an unknown Platform, or one this Owner may not access (one answer)' })
  @ApiResponse(R503)
  async list(@AssistanceOwner() owner: VerifiedAssistanceOwner, @Query('platformId') platformId?: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    if (this.config.isProduction) throw notFound();
    if (typeof platformId !== 'string' || !UUID.test(platformId.toLowerCase())) throw invalid();
    const p = page(after, limit);
    const platform = platformId.toLowerCase();
    if (!(await this.owners.platformAllowed(owner.bearer, platform, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    return { items: (await this.stalled.listForPlatform(platform, p.after, p.limit)).map(representReview) };
  }
}
