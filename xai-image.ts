import {
  assertApiKey,
  assertInSet,
  assertPrompt,
  createTempFilePath,
  DEFAULT_XAI_IMAGE_MODEL,
  normalizeImageList,
  persistBase64Asset,
  sanitizeCount,
  type GeneratedImageAsset,
  type XaiMediaLogger,
  XAI_IMAGE_ASPECT_RATIOS,
  XAI_IMAGE_QUALITIES,
  XAI_IMAGE_RESOLUTIONS,
  XAI_IMAGE_RESPONSE_FORMATS,
} from "./xai-media-shared.ts";
import { XaiClient, coerceXaiClient } from "./xai-client.ts";

const IMAGE_GENERATIONS_ENDPOINT = "/images/generations";
const IMAGE_EDITS_ENDPOINT = "/images/edits";

export interface GenerateImageParams {
  prompt: string;
  n?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  responseFormat?: string;
  model?: string;
}

export interface EditImageParams extends GenerateImageParams {
  image?: string;
  images?: string[];
}

export interface GenerateImageResult {
  ok: true;
  images: GeneratedImageAsset[];
  count: number;
  model: string;
}

interface ImageApiResult {
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
    respect_moderation?: boolean;
  }>;
  model?: string;
}

async function persistImageResults(
  client: XaiClient,
  result: ImageApiResult,
  fileName: string,
  log?: XaiMediaLogger,
): Promise<GeneratedImageAsset[]> {
  const images: GeneratedImageAsset[] = [];
  for (const item of result.data ?? []) {
    const filePath = createTempFilePath("images", fileName);
    if (item.url) {
      await client.downloadToFile(item.url, filePath, log);
    } else if (item.b64_json) {
      persistBase64Asset(item.b64_json, filePath);
    } else {
      continue;
    }
    images.push({
      path: filePath,
      sourceUrl: item.url,
      revisedPrompt: item.revised_prompt,
      respectModeration: item.respect_moderation,
    });
  }
  return images;
}

export async function generateImagesWithXai(
  clientOrApiKey: string | XaiClient,
  params: GenerateImageParams,
  log?: XaiMediaLogger,
): Promise<GenerateImageResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const aspectRatio = assertInSet(params.aspectRatio, XAI_IMAGE_ASPECT_RATIOS, "aspectRatio");
  const resolution = assertInSet(params.resolution, XAI_IMAGE_RESOLUTIONS, "resolution");
  const quality = assertInSet(params.quality, XAI_IMAGE_QUALITIES, "quality");
  const responseFormat = assertInSet(
    params.responseFormat,
    XAI_IMAGE_RESPONSE_FORMATS,
    "responseFormat",
  );

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_IMAGE_MODEL,
    prompt,
    n: sanitizeCount(params.n),
    response_format: responseFormat || "url",
  };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (quality) body.quality = quality;

  log?.info?.(`[xai-media] image generate prompt="${prompt.slice(0, 80)}" n=${String(body.n)}`);
  const result = await client.fetchJson<ImageApiResult>(
    IMAGE_GENERATIONS_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    log,
  );

  if (!result.data?.length) {
    throw new Error("No images returned from xAI.");
  }

  const images = await persistImageResults(client, result, "image.png", log);
  if (!images.length) {
    throw new Error("Failed to persist generated images.");
  }

  return {
    ok: true,
    images,
    count: images.length,
    model: result.model?.trim() || String(body.model),
  };
}

export async function editImagesWithXai(
  clientOrApiKey: string | XaiClient,
  params: EditImageParams,
  log?: XaiMediaLogger,
): Promise<GenerateImageResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const inputImages = await normalizeImageList([
    ...(params.image ? [params.image] : []),
    ...(params.images ?? []),
  ]);
  if (!inputImages.length) {
    throw new Error("Image editing requires at least one source image.");
  }

  const aspectRatio = assertInSet(params.aspectRatio, XAI_IMAGE_ASPECT_RATIOS, "aspectRatio");
  const resolution = assertInSet(params.resolution, XAI_IMAGE_RESOLUTIONS, "resolution");
  const quality = assertInSet(params.quality, XAI_IMAGE_QUALITIES, "quality");
  const responseFormat = assertInSet(
    params.responseFormat,
    XAI_IMAGE_RESPONSE_FORMATS,
    "responseFormat",
  );

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_IMAGE_MODEL,
    prompt,
    n: sanitizeCount(params.n),
    response_format: responseFormat || "url",
  };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (quality) body.quality = quality;
  if (inputImages.length === 1) {
    body.image = { type: "image_url", url: inputImages[0] };
  } else {
    body.images = inputImages.map((url) => ({ type: "image_url", url }));
  }

  log?.info?.(
    `[xai-media] image edit prompt="${prompt.slice(0, 80)}" images=${inputImages.length}`,
  );
  const result = await client.fetchJson<ImageApiResult>(
    IMAGE_EDITS_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    log,
  );

  if (!result.data?.length) {
    throw new Error("No edited images returned from xAI.");
  }

  const images = await persistImageResults(client, result, "edited-image.png", log);
  if (!images.length) {
    throw new Error("Failed to persist edited images.");
  }

  return {
    ok: true,
    images,
    count: images.length,
    model: result.model?.trim() || String(body.model),
  };
}
