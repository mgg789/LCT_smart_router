import { Module } from '@nestjs/common';
import { DatasetImportService } from './dataset-import.service';
import { UploadImportService } from './upload-import.service';

@Module({
  providers: [DatasetImportService, UploadImportService],
  exports: [DatasetImportService, UploadImportService],
})
export class ImportsModule {}
