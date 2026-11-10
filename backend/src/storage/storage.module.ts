/**
 * storage.module.ts
 * ---------------------------------------------------------------------------
 * File storage, for any module that needs it. Import this module and ask for
 * StorageService. To move files to an S3-compatible bucket later, provide a different
 * class for StorageService here - nothing else changes.
 */
import { Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { LocalStorageService, StorageService } from './storage.service';

@Module({
  controllers: [FilesController],
  providers: [{ provide: StorageService, useClass: LocalStorageService }],
  exports: [StorageService],
})
export class StorageModule {}
