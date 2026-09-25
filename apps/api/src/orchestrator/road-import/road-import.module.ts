import { Module } from '@nestjs/common';
import { RoadImportService } from './road-import.service';

/** Router road-resource import boundary used by the dispatcher API. */
@Module({
  providers: [RoadImportService],
  exports: [RoadImportService],
})
export class RoadImportModule {}
