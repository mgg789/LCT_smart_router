import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/time';
import { PrismaService } from '../../persistence';
import { PolicyService } from './policy.service';

/**
 * The catalogue of prepared policies.
 *
 * Seeded at start-up because a published task always carries a policy, and the default is
 * `fast` (context/32 section 6.2). An existing choice by the dispatcher is left alone: a
 * restart does not undo it.
 */
@Global()
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule implements OnModuleInit {
  constructor(
    private readonly policies: PolicyService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.policies.ensureCatalogue(this.prisma, this.clock.nowSeconds());
  }
}
