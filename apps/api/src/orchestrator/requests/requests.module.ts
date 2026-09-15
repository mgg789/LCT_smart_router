import { Module } from '@nestjs/common';
import { RequestsService } from './requests.service';

@Module({
  providers: [RequestsService],
  exports: [RequestsService],
})
export class RequestsModule {}
