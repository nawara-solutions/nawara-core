import { Controller, Delete, HttpCode, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CallerService, ServiceTokenGuard } from '@nawara/service-kit';
import { DeletionService } from './deletion.service.js';

/** Stage 17.7 (SDD §13): `DELETE /file/files/{id}`: owner (`delete`), logical deletion, idempotent; tickets never reach it. */
@ApiTags('deletion')
@Controller('file')
export class DeletionController {
  constructor(private readonly deletions: DeletionService) {}

  @Delete('files/:id')
  @HttpCode(202)
  @UseGuards(ServiceTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete the caller\'s file (delete): logical now, bytes removed asynchronously', description: 'AVAILABLE → DELETING (every ticket revoked, access stops at once) → DELETED when the object is gone. Idempotent: a DELETING or DELETED file answers 202 again.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({ name: 'X-Organization-Id', required: false, description: "The file's organization, when it has one" })
  @ApiResponse({ status: 202, description: 'The file, DELETING or DELETED' })
  @ApiResponse({ status: 404, description: 'file_not_found (also another owner\'s or organization\'s file)' })
  @ApiResponse({ status: 409, description: 'upload_in_progress | file_not_available (a refused or failed upload)' })
  requestDeletion(@CallerService() caller: string, @Req() req: Request, @Param('id') id: string) {
    return this.deletions.requestDeletion(caller, req, id);
  }
}
