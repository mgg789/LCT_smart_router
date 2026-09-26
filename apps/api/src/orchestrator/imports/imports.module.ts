import { Module } from '@nestjs/common';
import { DatasetImportService } from './dataset-import.service';
import { ImportPreparationService } from './import-preparation.service';
import { TabularImportService } from './tabular-import.service';
import { UploadImportService } from './upload-import.service';

@Module({
  providers: [
    DatasetImportService,
    ImportPreparationService,
    UploadImportService,
    TabularImportService,
  ],
  exports: [
    DatasetImportService,
    ImportPreparationService,
    UploadImportService,
    TabularImportService,
  ],
})
export class ImportsModule {}
