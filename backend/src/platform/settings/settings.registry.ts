/**
 * settings.registry.ts
 * ---------------------------------------------------------------------------
 * The list of every setting the system knows about, and the rule each one must
 * obey (a "schema": its type, its limits) plus its default value.
 *
 * Every part of the system registers its own settings from its OWN file, so two
 * developers never edit the same list:
 *     site.*   website settings        (website editor)
 *     shop.*   shop settings           (shop)
 *     platform.* learning-portal rules (learning portal)
 *
 * A setting nobody registered cannot be saved, and a saved value that breaks its
 * rule is refused - so a typo can never put the website into a strange state.
 */
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

export interface SettingDefinition<T = unknown> {
  /** "<group>.<name>", lowercase, e.g. "site.applications_open". */
  key: string;
  /** The first part of the key, e.g. "site". */
  group: string;
  /** Short name for the admin screen. */
  label: string;
  /** One sentence for the admin screen. */
  description?: string;
  /** What a valid value looks like. */
  schema: z.ZodType<T>;
  /** Used until an admin saves a value. It must itself be valid. */
  defaultValue: T;
  /** True = may be shown by public (signed-out) endpoints. Never mark private details public. */
  isPublic: boolean;
}

/**
 * Declares a setting with a properly typed default. (Returns it as a general
 * definition so settings of different types can sit in one list.)
 */
export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition {
  return definition as unknown as SettingDefinition;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

@Injectable()
export class SettingsRegistry {
  private readonly definitions = new Map<string, SettingDefinition>();

  /** Registers settings. Safe to call twice with the same definitions. */
  register(definitions: SettingDefinition[]): void {
    for (const definition of definitions) {
      if (!KEY_PATTERN.test(definition.key)) {
        throw new Error(`Setting key "${definition.key}" must look like "group.name" in lowercase.`);
      }
      if (!definition.key.startsWith(`${definition.group}.`)) {
        throw new Error(`Setting "${definition.key}" does not belong to its group "${definition.group}".`);
      }
      const existing = this.definitions.get(definition.key);
      if (existing && existing !== definition) {
        throw new Error(`Setting "${definition.key}" is registered twice with different rules.`);
      }
      if (!definition.schema.safeParse(definition.defaultValue).success) {
        throw new Error(`The default value of setting "${definition.key}" breaks its own rule.`);
      }
      this.definitions.set(definition.key, definition);
    }
  }

  get(key: string): SettingDefinition | undefined {
    return this.definitions.get(key);
  }

  require(key: string): SettingDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw new Error(`Setting "${key}" has not been registered.`);
    return definition;
  }

  /** Every setting, or only those of one group, in key order. */
  list(group?: string): SettingDefinition[] {
    return [...this.definitions.values()]
      .filter((definition) => !group || definition.group === group)
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}