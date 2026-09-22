import { Global, Module } from '@nestjs/common';
import { LiveModule } from '../live';
import { RewardsModule } from '../rewards';
import { PassportsService } from './passports.service';

/** Shares the passport service across engineer, dispatcher and demo contours. */
@Global()
@Module({
  imports: [LiveModule, RewardsModule],
  providers: [PassportsService],
  exports: [PassportsService],
})
export class PassportsModule {}
