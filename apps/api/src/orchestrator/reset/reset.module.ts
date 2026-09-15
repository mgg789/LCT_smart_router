import { Module } from '@nestjs/common';
import { ResetService } from './reset.service';

@Module({
  providers: [ResetService],
  exports: [ResetService],
})
export class ResetModule {}
