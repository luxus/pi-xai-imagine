import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { XAI_API_BASE } from "./xai-media-shared.ts";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];
interface JsonRecord {
  [key: string]: JsonValue;
}

export const USER_PI_SETTINGS_PATH = resolve(homedir(), ".pi/agent/settings.json");
export const PROJECT_PI_SETTINGS_PATH = resolve(process.cwd(), ".pi/settings.json");

export interface ResolvedXaiConfig {
  xai: {
    apiKey?: string;
    baseUrl: string;
    imagine: JsonRecord;
    voice: JsonRecord;
    search: JsonRecord;
  };
  loadedFiles: string[];
  apiKeySource?: string;
  legacyImagineFallback: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeRecords(base: JsonRecord, override: JsonRecord): JsonRecord {
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeRecords(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readJsonRecord(filePath: string): JsonRecord | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Pi settings file must contain JSON object: ${filePath}`);
  }
  return parsed;
}

function getNamespace(root: JsonRecord | undefined, key: string): JsonRecord {
  if (!root) return {};
  const value = root[key];
  return isRecord(value) ? value : {};
}

function getString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getPiSettingsPaths(): { user: string; project: string } {
  return {
    user: USER_PI_SETTINGS_PATH,
    project: PROJECT_PI_SETTINGS_PATH,
  };
}

export function resolveXaiConfig(): ResolvedXaiConfig {
  const userSettings = readJsonRecord(USER_PI_SETTINGS_PATH);
  const projectSettings = readJsonRecord(PROJECT_PI_SETTINGS_PATH);
  const loadedFiles = [
    ...(userSettings ? [USER_PI_SETTINGS_PATH] : []),
    ...(projectSettings ? [PROJECT_PI_SETTINGS_PATH] : []),
  ];

  const mergedSettings = mergeRecords(userSettings ?? {}, projectSettings ?? {});
  const mergedXai = getNamespace(mergedSettings, "xai");
  const mergedImagine = getNamespace(mergedXai, "imagine");
  const legacyImagine = getNamespace(mergedSettings, "piXaiGen");
  const projectXai = getNamespace(projectSettings, "xai");
  const userXai = getNamespace(userSettings, "xai");
  const envApiKey = process.env.XAI_API_KEY?.trim();
  const projectApiKey = getString(projectXai, "apiKey");
  const userApiKey = getString(userXai, "apiKey");

  return {
    xai: {
      apiKey: envApiKey || projectApiKey || userApiKey,
      baseUrl: getString(mergedXai, "baseUrl") || XAI_API_BASE,
      imagine: mergeRecords(legacyImagine, mergedImagine),
      voice: getNamespace(mergedXai, "voice"),
      search: getNamespace(mergedXai, "search"),
    },
    loadedFiles,
    apiKeySource: envApiKey
      ? "env:XAI_API_KEY"
      : projectApiKey
        ? `project:${PROJECT_PI_SETTINGS_PATH}:xai.apiKey`
        : userApiKey
          ? `user:${USER_PI_SETTINGS_PATH}:xai.apiKey`
          : undefined,
    legacyImagineFallback: Object.keys(legacyImagine).length > 0,
  };
}

export function getRequiredXaiApiKey(config = resolveXaiConfig()): {
  apiKey: string;
  source: string;
  config: ResolvedXaiConfig;
} {
  const apiKey = config.xai.apiKey?.trim();
  if (!apiKey) {
    const paths = getPiSettingsPaths();
    throw new Error(
      `Missing xAI API key. Set XAI_API_KEY or configure xai.apiKey in ${paths.project} or ${paths.user}.`,
    );
  }
  return {
    apiKey,
    source: config.apiKeySource || "config:xai.apiKey",
    config,
  };
}
