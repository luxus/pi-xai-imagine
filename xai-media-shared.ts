import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent } from "@mariozechner/pi-ai";

export const XAI_API_BASE = "https://api.x.ai/v1";
export const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image";
export const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
export const DEFAULT_XAI_VISION_MODEL = "grok-4.20-reasoning";

export const XAI_IMAGE_ASPECT_RATIOS = new Set([
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "9:19.5",
  "19.5:9",
  "9:20",
  "20:9",
  "1:2",
  "2:1",
  "auto",
]);
export const XAI_IMAGE_RESOLUTIONS = new Set(["1k", "2k"]);
export const XAI_IMAGE_QUALITIES = new Set(["low", "medium", "high"]);
export const XAI_IMAGE_RESPONSE_FORMATS = new Set(["url", "b64_json"]);
export const XAI_VIDEO_ASPECT_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);
export const XAI_VIDEO_RESOLUTIONS = new Set(["480p", "720p"]);
export const XAI_VISION_DETAILS = new Set(["auto", "low", "high"]);

export interface XaiMediaLogger {
  debug?(msg: string, ...args: unknown[]): void;
  info?(msg: string, ...args: unknown[]): void;
  warn?(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
}

export interface GeneratedImageAsset {
  path: string;
  sourceUrl?: string;
  revisedPrompt?: string;
  respectModeration?: boolean;
}

export interface GeneratedVideoAsset {
  path: string;
  sourceUrl?: string;
  duration?: number;
  respectModeration?: boolean;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isDataUri(value: string): boolean {
  return /^data:[^;]+;base64,/i.test(value.trim());
}

export function sanitizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(Math.max(Math.floor(value), 1), 10);
}

export function sanitizeVideoDuration(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function inferMimeType(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

function ensureTempDir(kind: "images" | "videos"): string {
  const dir = join(tmpdir(), "pi-xai-imagine", kind);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function createTempFilePath(kind: "images" | "videos", fileName: string): string {
  const dir = ensureTempDir(kind);
  const safeExt = extname(fileName) || (kind === "videos" ? ".mp4" : ".png");
  const safeBase =
    basename(fileName, safeExt).replace(/[^a-zA-Z0-9._-]+/g, "-") ||
    (kind === "videos" ? "video" : "image");
  return join(dir, `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
}

export function assertApiKey(apiKey: string): void {
  if (!apiKey.trim()) {
    throw new Error("xAI API key is not configured.");
  }
}

export function assertPrompt(prompt: string): string {
  const value = prompt.trim();
  if (!value) throw new Error("prompt is required");
  return value;
}

export function assertVideoUrl(videoUrl: string): string {
  const value = videoUrl.trim();
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      "videoUrl must be a public or xAI-hosted HTTP(S) URL. Local video paths are not supported by documented xAI video edit/extend API.",
    );
  }
  return value;
}

export function assertInSet(
  value: string | undefined,
  allowed: Set<string>,
  field: string,
): string | undefined {
  if (!value) return undefined;
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return value;
}

export function persistBase64Asset(base64Data: string, filePath: string): void {
  writeFileSync(filePath, Buffer.from(base64Data, "base64"));
}

export async function normalizeImageAsset(source: string): Promise<string> {
  const value = source.trim();
  if (!value) throw new Error("Image source cannot be empty");
  if (isHttpUrl(value) || isDataUri(value)) return value;

  const mimeType = inferMimeType(value);
  const buffer = readFileSync(value);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function normalizeImageList(
  sources: string[] | undefined,
  maxImages = 5,
): Promise<string[]> {
  const values = (sources ?? []).map((value) => value.trim()).filter(Boolean);
  if (Number.isFinite(maxImages) && values.length > maxImages) {
    throw new Error(
      `Too many input images: ${values.length}. Maximum supported: ${String(maxImages)}.`,
    );
  }
  return await Promise.all(values.map((value) => normalizeImageAsset(value)));
}

export function filePathToDataUri(filePath: string): string {
  const mimeType = inferMimeType(filePath);
  const buffer = readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export function filePathToImageContent(filePath: string): ImageContent {
  return {
    type: "image",
    data: readFileSync(filePath).toString("base64"),
    mimeType: inferMimeType(filePath),
  };
}

export function filePathToFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
}
