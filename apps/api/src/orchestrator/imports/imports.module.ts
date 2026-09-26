import { Module } from '@nestjs/common';
import { DatasetImportService } from './dataset-import.service';
import { ImportPreparationService } from './import-preparation.service';
import { UploadImportService } from './upload-import.service';

@Module({
  providers: [DatasetImportService, ImportPreparationService, UploadImportService],
  exports: [DatasetImportService, ImportPreparationService, UploadImportService],
})
export class ImportsModule {}
