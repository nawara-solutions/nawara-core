import { Body, Controller, Header, Headers, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CallerService, RequireServiceOperation, ServiceOperationGuard, ServiceTokenGuard } from '@nawara/service-kit';
import { Actors, type AuthedRequest } from '../auth/auth.guard.js';
import { authError } from '../errors.js';
import { AUTH_MESSAGES } from '../messages.js';
import { AuthorizationReceiptService, type ReceiptConsumption } from './authorization-receipt.service.js';
import {
  ConsumeReceiptDto, IssueReceiptDto, IssuedReceiptDto, LookupConsumptionDto, ReceiptConsumptionDto,
} from './dto.js';
import { asHttp } from './receipt-http.js';

/** As Payment's `Idempotency-Key` (D-A2 §5.1). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const wire = (c: ReceiptConsumption) => ({
  receiptId: c.receiptId, consumeRef: c.consumeRef, consumedAt: c.consumedAt.toISOString(), approvedBy: { userId: c.approvedBy.userId },
  companyId: c.companyId,
});

/**
 * AUTH-01 (Core V2 S2-Auth.2; ADR-0067 decisions 1 and 2; D-A2 receipt contract §5.1): the Owner, with their own bearer and live session
 * (the `AuthGuard` proves an active `owner` from the database), turns a fresh factor-only refund-authorization step-up into a receipt for
 * one exact refund of their own Company. The secret is in the 201 body once and never again; nothing may cache it.
 */
@ApiTags('authorization-receipts')
@Controller('auth/admin/authorization-receipts')
export class AuthorizationReceiptController {
  constructor(@Inject(AuthorizationReceiptService) private readonly receipts: AuthorizationReceiptService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Actors('owner')
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '8 to 128 of A-Z a-z 0-9 . _ : -' })
  @ApiOperation({ summary: 'AUTH-01: issue a single-use authorization receipt for one refund of the Owner\'s own Company (factor-only refund-authorization step-up).' })
  @ApiResponse({ status: 201, type: IssuedReceiptDto, description: 'The receipt; its secret appears in this response only.' })
  @ApiResponse({ status: 400, description: 'idempotency_key_required, receipt_binding_invalid (malformed binding, or not the Owner\'s Company), validation_error, step_up_unsupported.' })
  @ApiResponse({ status: 401, description: 'unauthenticated.' })
  @ApiResponse({ status: 403, description: 'forbidden (not an Owner), step_up_required (missing, expired, used, wrong-purpose or wrong-session proof).' })
  @ApiResponse({ status: 409, description: 'Replay of the key: receipt_issued_response_lost (the receipt is voided), receipt_already_consumed, receipt_expired, idempotency_key_reused. Never a secret.' })
  @ApiResponse({ status: 503, description: 'receipt_unavailable (nothing changed), receipt_outcome_unknown (replay the same key).' })
  issue(@Body() dto: IssueReceiptDto, @Headers('idempotency-key') key: string | undefined, @Req() req: AuthedRequest) {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
      throw authError(400, 'idempotency_key_required', AUTH_MESSAGES.idempotencyKeyRequired);
    }
    return asHttp(async () => {
      const r = await this.receipts.issue({ userId: req.actor.userId, sid: req.actor.sid }, { stepUpToken: dto.stepUpToken, idempotencyKey: key, binding: dto.binding });
      return { receiptId: r.receiptId, secret: r.secret, expiresAt: r.expiresAt.toISOString() };
    });
  }
}

/**
 * AUTH-02 and AUTH-03 (Core V2 S2-Auth.2; ADR-0067 decision 3; D-A2 receipt contract §5.2, §5.3, §11.2): service-token routes only.
 * `ServiceTokenGuard` authenticates the calling SERVICE from its token (a user bearer is never a service credential; no header names the
 * caller); `ServiceOperationGuard` then requires the route's operation in `AUTH_SERVICE_POLICY` (deny by default; only
 * `payment-service` can hold one). Both failures are generic (`401`, `403 operation_not_permitted`).
 */
@ApiTags('authorization-receipts')
@Controller('auth/service/authorization-receipts')
@UseGuards(ServiceTokenGuard, ServiceOperationGuard)
@ApiBearerAuth()
export class ServiceAuthorizationReceiptController {
  constructor(@Inject(AuthorizationReceiptService) private readonly receipts: AuthorizationReceiptService) {}

  @Post('consume')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireServiceOperation('authorization_receipt.consume')
  @ApiOperation({ summary: 'AUTH-02: consume a receipt, once, for its bound audience. The same consumeRef repeated returns the same consumption.' })
  @ApiResponse({ status: 200, type: ReceiptConsumptionDto, description: 'The consumption; approvedBy is the issuing Owner.' })
  @ApiResponse({ status: 400, description: 'validation_error, receipt_binding_invalid.' })
  @ApiResponse({ status: 401, description: 'Not an authenticated service.' })
  @ApiResponse({ status: 403, description: 'operation_not_permitted; authority_revoked (the issuer is no longer an active Owner of the Company; the receipt is NOT consumed).' })
  @ApiResponse({ status: 409, description: 'receipt_invalid (no match, any binding difference, or voided), receipt_expired, consume_ref_conflict.' })
  @ApiResponse({ status: 503, description: 'receipt_unavailable (nothing changed), receipt_outcome_unknown (retry the same consumeRef or use AUTH-03).' })
  consume(@Body() dto: ConsumeReceiptDto, @CallerService() caller: string) {
    return asHttp(async () => wire(await this.receipts.consume(caller, { secret: dto.secret, binding: dto.binding, consumeRef: dto.consumeRef })));
  }

  @Post('consumptions/lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequireServiceOperation('authorization_receipt.lookup')
  @ApiOperation({ summary: 'AUTH-03: the consumption under consumeRef, for the caller that made it and the same binding. Read-only; never consumes.' })
  @ApiResponse({ status: 200, type: ReceiptConsumptionDto })
  @ApiResponse({ status: 400, description: 'validation_error, receipt_binding_invalid.' })
  @ApiResponse({ status: 401, description: 'Not an authenticated service.' })
  @ApiResponse({ status: 403, description: 'operation_not_permitted.' })
  @ApiResponse({ status: 404, description: 'not_found: no such consumption for this caller and binding (a mismatch is indistinguishable from absence).' })
  @ApiResponse({ status: 503, description: 'receipt_unavailable.' })
  lookup(@Body() dto: LookupConsumptionDto, @CallerService() caller: string) {
    return asHttp(async () => wire(await this.receipts.lookupConsumption(caller, { consumeRef: dto.consumeRef, binding: dto.binding })));
  }
}
