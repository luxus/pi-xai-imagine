import {
  DEFAULT_XAI_VISION_MODEL,
  XAI_VISION_DETAILS,
  assertApiKey,
  assertInSet,
  assertPrompt,
  normalizeImageList,
  type XaiMediaLogger,
} from "./xai-media-shared.ts";
import { XaiClient, coerceXaiClient } from "./xai-client.ts";

const RESPONSES_ENDPOINT = "/responses";

export interface UnderstandImageParams {
  prompt: string;
  image?: string;
  images?: string[];
  model?: string;
  detail?: string;
}

export interface UnderstandImageResult {
  ok: true;
  text: string;
  model: string;
  responseId?: string;
  imageCount: number;
  raw: unknown;
}

interface ResponsesApiResult {
  id?: string;
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

function extractResponseText(result: ResponsesApiResult): string {
  if (typeof result.output_text === "string" && result.output_text.trim()) {
    return result.output_text.trim();
  }

  const chunks: string[] = [];
  for (const item of result.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }

  if (chunks.length) return chunks.join("\n\n");
  throw new Error("xAI responses API returned no text output.");
}

export async function understandImageWithXai(
  clientOrApiKey: string | XaiClient,
  params: UnderstandImageParams,
  log?: XaiMediaLogger,
): Promise<UnderstandImageResult> {
  const client = coerceXaiClient(clientOrApiKey, log);
  assertApiKey(client.apiKey);
  const prompt = assertPrompt(params.prompt);
  const detail = assertInSet(params.detail, XAI_VISION_DETAILS, "detail");
  const sources = [...(params.image ? [params.image] : []), ...(params.images ?? [])];
  const images = await normalizeImageList(sources, Number.POSITIVE_INFINITY);
  if (!images.length) {
    throw new Error("Image understanding requires at least one image.");
  }

  const body: Record<string, unknown> = {
    model: params.model?.trim() || DEFAULT_XAI_VISION_MODEL,
    store: false,
    input: [
      {
        role: "user",
        content: [
          ...images.map((imageUrl) => ({
            type: "input_image",
            image_url: imageUrl,
            ...(detail ? { detail } : {}),
          })),
          { type: "input_text", text: prompt },
        ],
      },
    ],
  };

  log?.info?.(
    `[xai-media] image understanding prompt="${prompt.slice(0, 80)}" images=${images.length}`,
  );
  const result = await client.fetchJson<ResponsesApiResult>(
    RESPONSES_ENDPOINT,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    log,
  );

  return {
    ok: true,
    text: extractResponseText(result),
    model: result.model?.trim() || String(body.model),
    responseId: result.id?.trim(),
    imageCount: images.length,
    raw: result,
  };
}
