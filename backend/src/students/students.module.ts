/**
 * students.module.ts
 * ---------------------------------------------------------------------------
 * Everything a student does through the API: signing up and applying,
 * confirming her email, and her dashboard.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

@Module({
  imports: [AuthModule],
  controllers: [StudentsController],
  providers: [StudentsService],
})
export class StudentsModule {}