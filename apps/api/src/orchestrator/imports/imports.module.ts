import { Module } from '@nestjs/common';
import { DatasetImportService } from './dataset-import.service';

@Module({
  providers: [DatasetImportService],
  exports: [DatasetImportService],
})
export class ImportsModule {}
