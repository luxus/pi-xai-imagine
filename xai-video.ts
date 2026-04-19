import {
  assertApiKey,
  assertInSet,
  assertPrompt,
  assertVideoUrl,
  createTempFilePath,
  DEFAULT_XAI_VIDEO_MODEL,
  normalizeImageAsset,
  normalizeImageList,
  sanitizeVideoDuration,
  sleep,
  type GeneratedVideoAsset,
  type XaiMediaLogger,
  XAI_VIDEO_ASPECT_RATIOS,
  XAI_VIDEO_RESOLUTIONS,
} from "./xai-media-shared.ts";
import { XaiClient, coerceXaiClient } from "./xai-client.ts";

const VIDEO_GENERATIONS_ENDPOINT = "/videos/generations";
const VIDEO_EDITS_ENDPOINT = "/videos/edits";
const VIDEO_EXTENSIONS_ENDPOINT = "/videos/extensions";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface GenerateVideoParams {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  image?: string;
  referenceImages?: string[];
  model?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface EditVideoParams {
  prompt: string;
  videoUrl: string;
  model?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ExtendVideoParams extends EditVideoParams {
  duration?: number;
}

export interface GenerateVideoResult {
  ok: true;
  video: GeneratedVideoAsset;
  requestId: string;
  model: string;
}

interface VideoStatusResult {
  status?: "pending" | "done" | "failed" | "expired";
  model?: string;
  error?: string;
  video?: {
    url?: string;
    duration?: number;
    respect_moderation?: boolean;
  };
}

async function pollForVideo(
  client: XaiClient,
  requestId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  log?: XaiMediaLogger,
): Promise<VideoStatusResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.fetchJson<VideoStatusResult>(
      `/videos/${requestId}`,
      {
        method: "GET",
      },
      log,
    );

    if (result.status === "done") return result;
    if (result.status === "failed") {
      throw new Error(result.error?.trim() || "xAI video generation failed.");
    }
    if (result.status === "expired") {
      throw new Error("xAI video request expired before completion.");
    }

    await sleep(pollIntervalMs);
  }

  throw new Error("Timed out while waiting for xAI video generation.");
}

async function startVideoOperation(
  client: XaiClient,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  pollIntervalMs: number,
  log?: XaiMediaLogger,
): Promise<{ requestId: string; result: VideoStatusResult }> {
  const start = await client.fetchJson<{ request_id?: string }>(
    endpoint,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    log,
  );

  const requestId = start.request_id?.trim();
  if (!requestId) {
    throw new Error("xAI did not return a request_id for the video operation.");
  }

  const result = await pollForVideo(client, requestId, timeoutMs, pollIntervalMs, log);
  return { requestId, result };
}

async function persistVideoResult(
  client: XaiClient,
  requestId: string,
  result: VideoStatusResult,
  log?: XaiMediaLogger,
): Promise<GeneratedVideoAsset> {
  const sourceUrl = result.video?.url?.trim();
  if (!sourceUrl) {
    throw new Error("xAI video operation completed without a downloadable URL.");
  }

  const filePath = createTempFilePath("videos", `${requestId}.mp4`);
  await client.downloadToFile(sourceUrl, filePath, log);
  return {
    path: filePath,
    sourceUrl,
    duration: result.video?.duration,
    respectModeration: result.video?.respect_moderation,
  };
}

export async function generateVideoWithXai(
  clientOrApiKey: string | XaiClient,
  params: GenerateVideoParams,
  log?: XaiMediaLogger,
): Promise<GenerateVideoResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const aspectRatio = assertInSet(params.aspectRatio, XAI_VIDEO_ASPECT_RATIOS, "aspectRatio");
  const resolution = assertInSet(params.resolution, XAI_VIDEO_RESOLUTIONS, "resolution");
  const referenceImages = await normalizeImageList(params.referenceImages);
  const sourceImage = params.image ? await normalizeImageAsset(params.image) : undefined;
  if (sourceImage && referenceImages.length) {
    throw new Error(
      "xAI video generation does not allow `image` and `referenceImages` in same request. Use one mode only.",
    );
  }
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_VIDEO_MODEL,
    prompt,
    duration: sanitizeVideoDuration(params.duration, 1, 15, 5),
  };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (sourceImage) body.image = { url: sourceImage };
  if (referenceImages.length) {
    body.reference_images = referenceImages.map((url) => ({ url }));
  }

  log?.info?.(
    `[xai-media] video generate prompt="${prompt.slice(0, 80)}" image=${sourceImage ? "yes" : "no"} refs=${referenceImages.length}`,
  );
  const { requestId, result } = await startVideoOperation(
    client,
    VIDEO_GENERATIONS_ENDPOINT,
    body,
    timeoutMs,
    pollIntervalMs,
    log,
  );
  const video = await persistVideoResult(client, requestId, result, log);

  return {
    ok: true,
    video,
    requestId,
    model: result.model?.trim() || String(body.model),
  };
}

export async function editVideoWithXai(
  clientOrApiKey: string | XaiClient,
  params: EditVideoParams,
  log?: XaiMediaLogger,
): Promise<GenerateVideoResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const videoUrl = assertVideoUrl(params.videoUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_VIDEO_MODEL,
    prompt,
    video: { url: videoUrl },
  };

  log?.info?.(`[xai-media] video edit prompt="${prompt.slice(0, 80)}"`);
  const { requestId, result } = await startVideoOperation(
    client,
    VIDEO_EDITS_ENDPOINT,
    body,
    timeoutMs,
    pollIntervalMs,
    log,
  );
  const video = await persistVideoResult(client, requestId, result, log);

  return {
    ok: true,
    video,
    requestId,
    model: result.model?.trim() || String(body.model),
  };
}

export async function extendVideoWithXai(
  clientOrApiKey: string | XaiClient,
  params: ExtendVideoParams,
  log?: XaiMediaLogger,
): Promise<GenerateVideoResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const videoUrl = assertVideoUrl(params.videoUrl);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_VIDEO_MODEL,
    prompt,
    video: { url: videoUrl },
    duration: sanitizeVideoDuration(params.duration, 2, 10, 6),
  };

  log?.info?.(
    `[xai-media] video extend prompt="${prompt.slice(0, 80)}" duration=${String(body.duration)}`,
  );
  const { requestId, result } = await startVideoOperation(
    client,
    VIDEO_EXTENSIONS_ENDPOINT,
    body,
    timeoutMs,
    pollIntervalMs,
    log,
  );
  const video = await persistVideoResult(client, requestId, result, log);

  return {
    ok: true,
    video,
    requestId,
    model: result.model?.trim() || String(body.model),
  };
}
