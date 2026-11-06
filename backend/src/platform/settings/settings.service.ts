/**
 * settings.service.ts
 * ---------------------------------------------------------------------------
 * Reads and saves settings.
 *
 *  - A setting that an admin never changed uses its default (from the registry).
 *  - Saving checks EVERY value against its rule first; if any value is wrong,
 *    nothing is saved and the admin gets a clear list of what to fix.
 *  - Every save is audited with the previous and the new value of each setting
 *    that really changed (settings hold organisation facts such as "applications
 *    open" or a contact address - never personal details of people).
 *  - Values are cached for a few seconds, so busy public pages do not hit the
 *    database on every request. A save clears the cache at once.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';

import type { AuthenticatedUser, RequestContext } from '../../auth/auth.types';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingDefinition, SettingsRegistry } from './settings.registry';

const CACHE_MS = 5_000;

export interface SettingView {
  key: string;
  group: string;
  label: string;
  description: string | null;
  value: unknown;
  defaultValue: unknown;
  /** True when no admin has changed it (the default is in use). */
  isDefault: boolean;
  isPublic: boolean;
}

/** JSON "null" must be stored with a special marker, otherwise it means "no value". */
const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { loadedAt: number; rows: Map<string, unknown> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SettingsRegistry,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------- read

  /** One setting's value (the default when never changed). */
  async getValue<T = unknown>(key: string): Promise<T> {
    const definition = this.registry.require(key);
    return this.effectiveValue(definition, await this.storedRows()) as T;
  }

  /** Values of every setting in a group, keyed by setting key. */
  async getGroup(group: string): Promise<Record<string, unknown>> {
    const rows = await this.storedRows();
    const result: Record<string, unknown> = {};
    for (const definition of this.registry.list(group)) {
      result[definition.key] = this.effectiveValue(definition, rows);
    }
    return result;
  }

  /** For the admin screen: every setting with its rule text, value and default. */
  async describe(group?: string): Promise<SettingView[]> {
    const rows = await this.storedRows();
    return this.registry.list(group).map((definition) => ({
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description ?? null,
      value: this.effectiveValue(definition, rows),
      defaultValue: definition.defaultValue,
      isDefault: !rows.has(definition.key),
      isPublic: definition.isPublic,
    }));
  }

  // ------------------------------------------------------------------- save

  /**
   * Saves one or more settings. Either all of them are saved or none is.
   * Returns the settings of the groups that were touched.
   */
  async update(
    values: Record<string, unknown>,
    admin: AuthenticatedUser,
    context: RequestContext,
  ): Promise<SettingView[]> {
    const entries = Object.entries(values);
    if (entries.length === 0) throw new BadRequestException('Nothing to update.');

    // 1) Check every value first.
    const problems: string[] = [];
    const accepted = new Map<string, { definition: SettingDefinition; value: unknown }>();
    for (const [key, raw] of entries) {
      const definition = this.registry.get(key);
      if (!definition) {
        problems.push(`${key}: this setting does not exist.`);
        continue;
      }
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) {
        problems.push(`${key}: ${parsed.error.issues[0]?.message ?? 'this value is not allowed.'}`);
        continue;
      }
      accepted.set(key, { definition, value: parsed.data });
    }
    if (problems.length > 0) throw new BadRequestException(problems);

    // 2) Save what really changed, and audit it, in ONE transaction.
    await this.prisma.$transaction(async (tx) => {
      const rows = new Map(
        (await tx.platformSetting.findMany({ where: { key: { in: [...accepted.keys()] } } })).map((row) => [row.key, row.value]),
      );

      const previousValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};

      for (const [key, { definition, value }] of accepted) {
        const before = rows.has(key) ? rows.get(key) : definition.defaultValue;
        if (isDeepStrictEqual(before, value)) continue; // nothing really changed

        await tx.platformSetting.upsert({
          where: { key },
          create: { key, value: toJson(value), updatedById: admin.id },
          update: { value: toJson(value), updatedById: admin.id },
        });
        previousValue[key] = before ?? null;
        newValue[key] = value ?? null;
      }

      if (Object.keys(newValue).length > 0) {
        await this.audit.record(
          {
            actorId: admin.id,
            actorRole: admin.role,
            action: 'settings.updated',
            entityType: 'settings',
            metadata: { keys: Object.keys(newValue) },
            previousValue: previousValue as Prisma.InputJsonValue,
            newValue: newValue as Prisma.InputJsonValue,
            ipAddress: context.ipAddress,
          },
          tx,
        );
      }
    });

    this.cache = null;
    const groups = [...new Set([...accepted.values()].map(({ definition }) => definition.group))];
    return (await Promise.all(groups.map((group) => this.describe(group)))).flat();
  }

  // ---------------------------------------------------------------- helpers

  private effectiveValue(definition: SettingDefinition, rows: Map<string, unknown>): unknown {
    if (!rows.has(definition.key)) return definition.defaultValue;

    const stored = rows.get(definition.key);
    const parsed = definition.schema.safeParse(stored);
    if (parsed.success) return parsed.data;

    // A saved value that no longer obeys its rule (the rule changed later): fall back safely.
    this.logger.warn(`Setting "${definition.key}" holds an invalid value; using its default.`);
    return definition.defaultValue;
  }

  private async storedRows(): Promise<Map<string, unknown>> {
    if (this.cache && Date.now() - this.cache.loadedAt < CACHE_MS) return this.cache.rows;

    const rows = new Map((await this.prisma.platformSetting.findMany()).map((row) => [row.key, row.value]));
    this.cache = { loadedAt: Date.now(), rows };
    return rows;
  }
}