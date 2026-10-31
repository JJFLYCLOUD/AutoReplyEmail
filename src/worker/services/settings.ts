import { encryptSecret, type EncryptedSecret } from "../lib/crypto";
import { parseJson } from "../lib/util";
import type { Env } from "../types";

export const SETTINGS_KEY = "app";

export interface AiSettings {
  enabled: boolean;
  provider: "workers-ai" | "external";
  workersAiModel: string;
  externalBaseUrl: string;
  externalModel: string;
  dailyRequestLimit: number;
  classifyFallback: boolean;
  externalApiKey?: EncryptedSecret | null;
}

export interface StoredSettings {
  ai: AiSettings;
  retentionDays: number;
  globalDailyLimit: number;
  timezone: string;
}

export interface PublicSettings extends Omit<StoredSettings, "ai"> {
  ai: Omit<AiSettings, "externalApiKey"> & { hasExternalApiKey: boolean };
}

export function defaultSettings(env: Env): StoredSettings {
  const retention = Number(env.RAW_RETENTION_DAYS || 30);
  return {
    ai: {
      enabled: false,
      provider: "workers-ai",
      workersAiModel: env.DEFAULT_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct",
      externalBaseUrl: "https://api.openai.com/v1",
      externalModel: "gpt-4o-mini",
      dailyRequestLimit: 200,
      classifyFallback: false,
      externalApiKey: null,
    },
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : 30,
    globalDailyLimit: 500,
    timezone: "UTC",
  };
}

export async function loadSettings(env: Env): Promise<StoredSettings> {
  const row = await env.DB.prepare("SELECT value_json FROM settings WHERE key = ?")
    .bind(SETTINGS_KEY)
    .first<{ value_json: string }>();
  const stored = parseJson<Partial<StoredSettings>>(row?.value_json, {});
  const defaults = defaultSettings(env);
  return {
    ...defaults,
    ...stored,
    ai: { ...defaults.ai, ...(stored.ai || {}) },
  };
}

export function toPublicSettings(settings: StoredSettings): PublicSettings {
  const { externalApiKey, ...ai } = settings.ai;
  return {
    ...settings,
    ai: {
      ...ai,
      hasExternalApiKey: Boolean(externalApiKey?.ct),
    },
  };
}

export interface SettingsPatch {
  ai?: {
    enabled?: boolean;
    provider?: "workers-ai" | "external";
    workersAiModel?: string;
    externalBaseUrl?: string;
    externalModel?: string;
    dailyRequestLimit?: number;
    classifyFallback?: boolean;
    externalApiKey?: string | null;
  };
  retentionDays?: number;
  globalDailyLimit?: number;
  timezone?: string;
}

export async function updateSettings(env: Env, patch: SettingsPatch): Promise<StoredSettings> {
  const current = await loadSettings(env);
  const { externalApiKey, ...aiPatch } = patch.ai || {};
  const next: StoredSettings = {
    ...current,
    retentionDays: patch.retentionDays ?? current.retentionDays,
    globalDailyLimit: patch.globalDailyLimit ?? current.globalDailyLimit,
    timezone: patch.timezone ?? current.timezone,
    ai: { ...current.ai, ...aiPatch },
  };

  if (patch.ai && "externalApiKey" in patch.ai) {
    if (patch.ai.externalApiKey) {
      if (!env.CREDENTIAL_KEY) throw new Error("CREDENTIAL_KEY is not configured");
      next.ai.externalApiKey = await encryptSecret(patch.ai.externalApiKey, env.CREDENTIAL_KEY);
    } else {
      next.ai.externalApiKey = null;
    }
  }

  await env.DB.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
  )
    .bind(SETTINGS_KEY, JSON.stringify(next))
    .run();

  return next;
}
