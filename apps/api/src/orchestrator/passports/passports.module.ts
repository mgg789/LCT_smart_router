import { Global, Module } from '@nestjs/common';
import { LiveModule } from '../live';
import { PassportsService } from './passports.service';

/** Shares the passport service across engineer, dispatcher and demo contours. */
@Global()
@Module({ imports: [LiveModule], providers: [PassportsService], exports: [PassportsService] })
export class PassportsModule {}
