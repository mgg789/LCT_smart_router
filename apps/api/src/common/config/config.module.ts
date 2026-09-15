import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      /**
       * Real environment variables always win; a file is only a convenience for running
       * the service outside a container. Both candidates are tried because the working
       * directory differs between `pnpm --filter api ...` (apps/api) and the image
       * (/app). A missing file is not an error.
       */
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
