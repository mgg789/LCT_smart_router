import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/**
 * Mail intents sys prepares. Transport belongs to the external SMTP server and is not part
 * of this build, so nothing here sends anything.
 */
@Global()
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
