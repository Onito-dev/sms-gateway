import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../common/errors.js";

/**
 * Stable setting keys. Values are validated JSON payloads; each key documents
 * its own shape below.
 */
export const SETTING_KEYS = {
  /** { allowedOrigins: ["*"] | ["https://a.example", ...] } */
  CORS_ORIGINS: "cors_origins",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** An origin is `*` or a scheme://host[:port] value (no path, no credentials). */
const originSchema = z
  .string()
  .trim()
  .max(253)
  .regex(/^(\*|https?:\/\/[a-zA-Z0-9._~%-]+(?::\d{1,5})?)$/, "Origin must be * or scheme://host[:port]");

const corsOriginsSchema = z
  .object({
    allowedOrigins: z.array(originSchema).min(1).max(50),
  })
  .strict();

export type CorsOriginsSetting = z.infer<typeof corsOriginsSchema>;

const settingSchemas: Record<SettingKey, z.ZodType> = {
  [SETTING_KEYS.CORS_ORIGINS]: corsOriginsSchema,
};

export type CorsOriginCheck =
  | { kind: "allow_all" }
  | { kind: "list"; allowedOrigins: string[] };

/**
 * Runtime-editable settings stored in PostgreSQL. Every value is re-validated
 * on read, so a hand-edited row can never inject a malformed payload.
 */
export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get<T>(key: SettingKey): Promise<T | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row ? (this.decode(key, row.value) as T) : null;
  }

  async getOrDefault<T>(key: SettingKey, fallback: T): Promise<T> {
    return (await this.get<T>(key)) ?? fallback;
  }

  /**
   * Upserts a validated value. Duplicate origins are rejected so the admin
   * list stays canonical.
   */
  async set(key: SettingKey, value: unknown): Promise<unknown> {
    const schema = settingSchemas[key];
    if (!schema) throw AppError.validation(`Unknown setting key: ${key}`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw AppError.validation("Setting validation failed", parsed.error.issues);
    }
    if (key === SETTING_KEYS.CORS_ORIGINS) {
      const { allowedOrigins } = parsed.data as CorsOriginsSetting;
      const unique = new Set(allowedOrigins.map((origin) => origin.toLowerCase()));
      if (unique.size !== allowedOrigins.length) {
        throw AppError.validation("Duplicate origins are not allowed");
      }
    }
    try {
      const row = await this.prisma.setting.upsert({
        where: { key },
        update: { value: parsed.data as object },
        create: { key, value: parsed.data as object },
      });
      return this.decode(key, row.value);
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw AppError.conflict("Setting was modified concurrently, retry");
      }
      throw error;
    }
  }

  /** Normalized view used by the CORS origin resolver in app.ts. */
  async getCorsOriginCheck(): Promise<CorsOriginCheck> {
    const setting = await this.get<CorsOriginsSetting>(SETTING_KEYS.CORS_ORIGINS);
    if (!setting) return { kind: "list", allowedOrigins: [] };
    const [first] = setting.allowedOrigins;
    if (first === "*") return { kind: "allow_all" };
    return { kind: "list", allowedOrigins: setting.allowedOrigins.map((origin) => origin.toLowerCase()) };
  }

  private decode(key: SettingKey, value: unknown): unknown {
    const schema = settingSchemas[key];
    if (!schema) return value;
    const parsed = schema.safeParse(value);
    // A malformed DB row (hand-edited) is treated as unset rather than
    // crashing every request that consults the setting.
    return parsed.success ? parsed.data : null;
  }
}
