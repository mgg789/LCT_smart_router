import { Module } from '@nestjs/common';
import { RewardsService } from './rewards.service';

/** Exposes the unified rewards ledger to LIVE actions, passports and reports. */
@Module({ providers: [RewardsService], exports: [RewardsService] })
export class RewardsModule {}
