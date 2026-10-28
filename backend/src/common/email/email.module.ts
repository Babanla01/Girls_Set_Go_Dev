/**
 * email.module.ts
 * ---------------------------------------------------------------------------
 * Real email sending. The website API only QUEUES emails (the outbox); this
 * module's sender - run by the command "npm run email:send" - delivers them.
 */
import { Module } from '@nestjs/common';

import { EmailSenderService } from './email-sender.service';
import { MailTransport } from './mail.transport';

@Module({
  providers: [MailTransport, EmailSenderService],
  exports: [MailTransport, EmailSenderService],
})
export class EmailModule {}