import { Injectable } from '@nestjs/common';
import type { RoadImportDto } from '../../api/dto/road-import.dto';
import { RouterClient, type RouterRoadImportResult } from '../../routing/router-gateway';

/** Forwards validated dispatcher uploads to the private Router Core boundary. */
@Injectable()
export class RoadImportService {
  constructor(private readonly router: RouterClient) {}

  /** Preserve the operation id across System Layer and Core for replay safety. */
  importRoadData(input: RoadImportDto): Promise<RouterRoadImportResult> {
    return this.router.importRoadData({
      operationId: input.operationId,
      profile: input.profile,
      ...(input.source === undefined ? {} : { source: input.source }),
      payloadBase64: input.payloadBase64,
    });
  }
}
