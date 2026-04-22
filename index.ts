import { StringEnum } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { openXaiStudio } from "./xai-glimpse.ts";
import { editImagesWithXai, generateImagesWithXai } from "./xai-image.ts";
import {
  DEFAULT_XAI_IMAGE_MODEL,
  DEFAULT_XAI_VIDEO_MODEL,
  DEFAULT_XAI_VISION_MODEL,
  XAI_IMAGE_ASPECT_RATIOS,
  XAI_IMAGE_QUALITIES,
  XAI_IMAGE_RESPONSE_FORMATS,
  XAI_IMAGE_RESOLUTIONS,
  XAI_VIDEO_ASPECT_RATIOS,
  XAI_VIDEO_RESOLUTIONS,
  XAI_VISION_DETAILS,
  filePathToImageContent,
  summarizeError,
  type GeneratedImageAsset,
  type GeneratedVideoAsset,
  type XaiMediaLogger,
} from "./xai-media-shared.ts";
import { XaiClient } from "./xai-client.ts";
import { getRequiredXaiApiKey, type ResolvedXaiConfig } from "./xai-config.ts";
import { understandImageWithXai } from "./xai-understanding.ts";
import { editVideoWithXai, extendVideoWithXai, generateVideoWithXai } from "./xai-video.ts";

const IMAGE_ASPECT_RATIO_VALUES = [...XAI_IMAGE_ASPECT_RATIOS] as [string, ...string[]];
const IMAGE_RESOLUTION_VALUES = [...XAI_IMAGE_RESOLUTIONS] as [string, ...string[]];
const IMAGE_QUALITY_VALUES = [...XAI_IMAGE_QUALITIES] as [string, ...string[]];
const IMAGE_RESPONSE_FORMAT_VALUES = [...XAI_IMAGE_RESPONSE_FORMATS] as [string, ...string[]];
const VIDEO_ASPECT_RATIO_VALUES = [...XAI_VIDEO_ASPECT_RATIOS] as [string, ...string[]];
const VIDEO_RESOLUTION_VALUES = [...XAI_VIDEO_RESOLUTIONS] as [string, ...string[]];
const VISION_DETAIL_VALUES = [...XAI_VISION_DETAILS] as [string, ...string[]];

function createLogger(): XaiMediaLogger {
  return console;
}

function createRuntime(log = createLogger()): {
  apiKey: string;
  apiKeySource: string;
  config: ResolvedXaiConfig;
  client: XaiClient;
  log: XaiMediaLogger;
} {
  const { apiKey, source, config } = getRequiredXaiApiKey();
  return {
    apiKey,
    apiKeySource: source,
    config,
    client: new XaiClient({ apiKey, baseUrl: config.xai.baseUrl, log }),
    log,
  };
}

function imageSummary(
  action: string,
  result: { count: number; model: string; images: GeneratedImageAsset[] },
  note?: string,
): string {
  const lines = [`${action} ${result.count} image(s).`, `Model: ${result.model}`, "Files:"];
  for (const [index, image] of result.images.entries()) {
    const moderation = image.respectModeration === false ? " [moderation=false]" : "";
    lines.push(`${index + 1}. ${image.path}${moderation}`);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

function videoSummary(
  action: string,
  result: { requestId: string; model: string; video: GeneratedVideoAsset },
  note?: string,
): string {
  const lines = [
    `${action} video ready.`,
    `Model: ${result.model}`,
    `Request: ${result.requestId}`,
    `File: ${result.video.path}`,
  ];
  if (result.video.sourceUrl) lines.push(`Source URL: ${result.video.sourceUrl}`);
  if (typeof result.video.duration === "number") lines.push(`Duration: ${result.video.duration}s`);
  if (typeof result.video.respectModeration === "boolean") {
    lines.push(`Respect moderation: ${String(result.video.respectModeration)}`);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

function imageContent(result: { images: GeneratedImageAsset[] }, summary: string) {
  return [
    { type: "text" as const, text: summary },
    ...result.images.slice(0, 4).map((image) => filePathToImageContent(image.path)),
  ];
}

async function maybeOpenStudio(options: {
  glimpse?: boolean;
  apiKey: string;
  config?: ResolvedXaiConfig;
  seedImages?: GeneratedImageAsset[];
  seedImageOriginalPrompt?: string;
  seedVideos?: GeneratedVideoAsset[];
  title?: string;
}): Promise<string | undefined> {
  const configuredAutoOpen = options.config?.xai.imagine.autoOpenGlimpse;
  const shouldOpen =
    typeof options.glimpse === "boolean"
      ? options.glimpse
      : typeof configuredAutoOpen === "boolean"
        ? configuredAutoOpen
        : true;
  if (!shouldOpen) return undefined;
  try {
    await openXaiStudio({
      apiKey: options.apiKey,
      seedImages: options.seedImages,
      seedImageOriginalPrompt: options.seedImageOriginalPrompt,
      seedVideos: options.seedVideos,
      title: options.title,
    });
    return "Glimpse studio opened.";
  } catch (error) {
    return `Glimpse unavailable: ${summarizeError(error)}`;
  }
}

async function runXaiHealthCheck() {
  const runtime = createRuntime();
  const health = await runtime.client.checkHealth(runtime.log);
  return {
    ...health,
    apiKeySource: runtime.apiKeySource,
    loadedFiles: runtime.config.loadedFiles,
    legacyImagineFallback: runtime.config.legacyImagineFallback,
  };
}

function xaiHealthSummary(result: {
  baseUrl: string;
  modelCount: number;
  sampleModels: string[];
  apiKeySource: string;
  loadedFiles: string[];
  legacyImagineFallback: boolean;
}): string {
  const lines = [
    "xAI health OK.",
    `Base URL: ${result.baseUrl}`,
    `API key: ${result.apiKeySource}`,
    `Models visible: ${result.modelCount}`,
    "Config namespaces: xai.imagine, xai.voice, xai.search",
  ];
  if (result.sampleModels.length) lines.push(`Sample models: ${result.sampleModels.join(", ")}`);
  if (result.loadedFiles.length) lines.push(`Settings: ${result.loadedFiles.join(", ")}`);
  if (result.legacyImagineFallback) lines.push("Legacy piXaiGen settings merged into xai.imagine.");
  return lines.join("\n");
}

const COMMON_GLIMPSE_PARAM = Type.Optional(
  Type.Boolean({
    description:
      "Open result in native Glimpse studio for further remix/edit/video actions. Optional.",
  }),
);

const IMAGE_SOURCE_ARRAY = Type.Optional(
  Type.Array(Type.String({ description: "Local file path, public URL, or base64 data URI." }), {
    description:
      "Input images. xAI image editing supports up to 5 images. Generate-image treats these as remix/reference images.",
  }),
);

const generateImageTool = defineTool({
  name: "generate_image",
  label: "generate_image",
  description:
    "Generate one or more images with xAI. Optional referenceImages remix/guidance supported by transparently using xAI image edit flow. Can optionally open Glimpse studio.",
  promptSnippet:
    "generate_image(prompt, referenceImages?) -> xAI image gen/remix; optional Glimpse studio",
  promptGuidelines: [
    "Use generate_image for new stills or remixing from reference images.",
    "If user wants interactive Grok-like image/video workflow, use open_xai_studio.",
  ],
  parameters: Type.Object({
    prompt: Type.String({ description: "What image to create or remix." }),
    referenceImages: IMAGE_SOURCE_ARRAY,
    n: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description: "How many images to generate. Default 1.",
      }),
    ),
    aspectRatio: Type.Optional(
      StringEnum(IMAGE_ASPECT_RATIO_VALUES, { description: "Aspect ratio override." }),
    ),
    resolution: Type.Optional(
      StringEnum(IMAGE_RESOLUTION_VALUES, { description: "Output resolution. 1k or 2k." }),
    ),
    quality: Type.Optional(StringEnum(IMAGE_QUALITY_VALUES, { description: "Quality hint." })),
    responseFormat: Type.Optional(
      StringEnum(IMAGE_RESPONSE_FORMAT_VALUES, {
        description:
          "url downloads from temporary xAI URL. b64_json returns base64 payload that tool saves locally.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: `Model override. Default ${DEFAULT_XAI_IMAGE_MODEL}.` }),
    ),
    glimpse: COMMON_GLIMPSE_PARAM,
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Calling xAI image API..." }],
      details: { status: "running" },
    });
    const result = params.referenceImages?.length
      ? await editImagesWithXai(
          runtime.client,
          {
            prompt: params.prompt,
            n: params.n,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            quality: params.quality,
            responseFormat: params.responseFormat,
            model: params.model,
            images: params.referenceImages,
          },
          runtime.log,
        )
      : await generateImagesWithXai(
          runtime.client,
          {
            prompt: params.prompt,
            n: params.n,
            aspectRatio: params.aspectRatio,
            resolution: params.resolution,
            quality: params.quality,
            responseFormat: params.responseFormat,
            model: params.model,
          },
          runtime.log,
        );
    const studioNote = await maybeOpenStudio({
      glimpse: params.glimpse,
      apiKey: runtime.apiKey,
      config: runtime.config,
      seedImages: result.images,
      seedImageOriginalPrompt: params.prompt,
      title: "Pi xAI Imagine Studio",
    });
    const summary = imageSummary(
      params.referenceImages?.length ? "Remixed" : "Generated",
      result,
      studioNote,
    );
    return {
      content: imageContent(result, summary),
      details: { ...result, mode: params.referenceImages?.length ? "remix" : "generate" },
    };
  },
});

const editImageTool = defineTool({
  name: "edit_image",
  label: "edit_image",
  description:
    "Edit one or more existing images with xAI using natural language. Accepts local files, public URLs, or base64 data URIs. Can optionally open Glimpse studio.",
  promptSnippet: "edit_image(prompt, image/images) -> xAI image edit; optional Glimpse studio",
  parameters: Type.Object({
    prompt: Type.String({ description: "Describe changes to make." }),
    image: Type.Optional(Type.String({ description: "Single source image path/URL/data URI." })),
    images: IMAGE_SOURCE_ARRAY,
    n: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        description: "How many edited variations to return.",
      }),
    ),
    aspectRatio: Type.Optional(
      StringEnum(IMAGE_ASPECT_RATIO_VALUES, { description: "Aspect ratio override." }),
    ),
    resolution: Type.Optional(
      StringEnum(IMAGE_RESOLUTION_VALUES, { description: "Output resolution. 1k or 2k." }),
    ),
    quality: Type.Optional(StringEnum(IMAGE_QUALITY_VALUES, { description: "Quality hint." })),
    responseFormat: Type.Optional(
      StringEnum(IMAGE_RESPONSE_FORMAT_VALUES, { description: "url or b64_json." }),
    ),
    model: Type.Optional(
      Type.String({ description: `Model override. Default ${DEFAULT_XAI_IMAGE_MODEL}.` }),
    ),
    glimpse: COMMON_GLIMPSE_PARAM,
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Editing image with xAI..." }],
      details: { status: "running" },
    });
    const result = await editImagesWithXai(runtime.client, params, runtime.log);
    const studioNote = await maybeOpenStudio({
      glimpse: params.glimpse,
      apiKey: runtime.apiKey,
      config: runtime.config,
      seedImages: result.images,
      seedImageOriginalPrompt: params.prompt,
      title: "Pi xAI Imagine Studio",
    });
    const summary = imageSummary("Edited", result, studioNote);
    return {
      content: imageContent(result, summary),
      details: result,
    };
  },
});

const generateVideoTool = defineTool({
  name: "generate_video",
  label: "generate_video",
  description:
    "Generate xAI video from text, from one source image, or from reference images. `image` and `referenceImages` are mutually exclusive. Can optionally open Glimpse studio.",
  promptSnippet:
    "generate_video(prompt, image|referenceImages?) -> xAI text/image/reference video; optional Glimpse studio",
  promptGuidelines: [
    "Use either image or referenceImages for xAI video generation, never both in same request.",
  ],
  parameters: Type.Object({
    prompt: Type.String({ description: "Describe motion, scene, camera, mood." }),
    image: Type.Optional(
      Type.String({ description: "Still image path/URL/data URI for image-to-video." }),
    ),
    referenceImages: IMAGE_SOURCE_ARRAY,
    duration: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 15, description: "Video length in seconds." }),
    ),
    aspectRatio: Type.Optional(
      StringEnum(VIDEO_ASPECT_RATIO_VALUES, { description: "Output aspect ratio." }),
    ),
    resolution: Type.Optional(
      StringEnum(VIDEO_RESOLUTION_VALUES, { description: "480p or 720p." }),
    ),
    model: Type.Optional(
      Type.String({ description: `Model override. Default ${DEFAULT_XAI_VIDEO_MODEL}.` }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, description: "Polling timeout in ms." }),
    ),
    pollIntervalMs: Type.Optional(
      Type.Integer({ minimum: 100, description: "Polling interval in ms." }),
    ),
    glimpse: COMMON_GLIMPSE_PARAM,
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Starting xAI video generation. Polling until ready..." }],
      details: { status: "running" },
    });
    const result = await generateVideoWithXai(runtime.client, params, runtime.log);
    const studioNote = await maybeOpenStudio({
      glimpse: params.glimpse,
      apiKey: runtime.apiKey,
      config: runtime.config,
      seedVideos: [result.video],
      title: "Pi xAI Imagine Studio",
    });
    const summary = videoSummary("Generated", result, studioNote);
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  },
});

const editVideoTool = defineTool({
  name: "edit_video",
  label: "edit_video",
  description:
    "Edit existing xAI/public video URL with natural language. Output inherits input duration/aspect/resolution. Can optionally open Glimpse studio.",
  promptSnippet: "edit_video(prompt, videoUrl) -> xAI video edit; optional Glimpse studio",
  parameters: Type.Object({
    prompt: Type.String({ description: "Describe video changes." }),
    videoUrl: Type.String({ description: "Public or xAI-hosted source video URL." }),
    model: Type.Optional(
      Type.String({ description: `Model override. Default ${DEFAULT_XAI_VIDEO_MODEL}.` }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, description: "Polling timeout in ms." }),
    ),
    pollIntervalMs: Type.Optional(
      Type.Integer({ minimum: 100, description: "Polling interval in ms." }),
    ),
    glimpse: COMMON_GLIMPSE_PARAM,
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Editing xAI video. Polling until ready..." }],
      details: { status: "running" },
    });
    const result = await editVideoWithXai(runtime.client, params, runtime.log);
    const studioNote = await maybeOpenStudio({
      glimpse: params.glimpse,
      apiKey: runtime.apiKey,
      config: runtime.config,
      seedVideos: [result.video],
      title: "Pi xAI Imagine Studio",
    });
    const summary = videoSummary("Edited", result, studioNote);
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  },
});

const extendVideoTool = defineTool({
  name: "extend_video",
  label: "extend_video",
  description:
    "Extend existing xAI/public video URL from last frame with natural language continuation. Duration controls added portion only. Can optionally open Glimpse studio.",
  promptSnippet:
    "extend_video(prompt, videoUrl, duration?) -> xAI video extension; optional Glimpse studio",
  parameters: Type.Object({
    prompt: Type.String({ description: "Describe what happens next." }),
    videoUrl: Type.String({ description: "Public or xAI-hosted source video URL." }),
    duration: Type.Optional(
      Type.Integer({ minimum: 2, maximum: 10, description: "Extension length in seconds." }),
    ),
    model: Type.Optional(
      Type.String({ description: `Model override. Default ${DEFAULT_XAI_VIDEO_MODEL}.` }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1_000, description: "Polling timeout in ms." }),
    ),
    pollIntervalMs: Type.Optional(
      Type.Integer({ minimum: 100, description: "Polling interval in ms." }),
    ),
    glimpse: COMMON_GLIMPSE_PARAM,
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Extending xAI video. Polling until ready..." }],
      details: { status: "running" },
    });
    const result = await extendVideoWithXai(runtime.client, params, runtime.log);
    const studioNote = await maybeOpenStudio({
      glimpse: params.glimpse,
      apiKey: runtime.apiKey,
      config: runtime.config,
      seedVideos: [result.video],
      title: "Pi xAI Imagine Studio",
    });
    const summary = videoSummary("Extended", result, studioNote);
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  },
});

const understandImageTool = defineTool({
  name: "understand_image",
  label: "understand_image",
  description:
    "Analyze one or more images with xAI reasoning/vision model. Uses /responses with store:false, so server-side history is not retained. Good for describing, extracting, or comparing images.",
  promptSnippet: "understand_image(prompt, image/images) -> xAI vision reasoning over image inputs",
  parameters: Type.Object({
    prompt: Type.String({ description: "Question or task about provided image(s)." }),
    image: Type.Optional(Type.String({ description: "Single image path/URL/data URI." })),
    images: Type.Optional(
      Type.Array(Type.String({ description: "Local file path, public URL, or base64 data URI." }), {
        description:
          "One or more input images. xAI vision allows many images; supported file types documented as jpg/jpeg/png.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: `Vision model override. Default ${DEFAULT_XAI_VISION_MODEL}.` }),
    ),
    detail: Type.Optional(
      StringEnum(VISION_DETAIL_VALUES, { description: "Image detail level for vision input." }),
    ),
  }),
  async execute(_toolCallId, params, _signal, onUpdate) {
    const runtime = createRuntime();
    onUpdate?.({
      content: [{ type: "text", text: "Analyzing image with xAI vision..." }],
      details: { status: "running" },
    });
    const result = await understandImageWithXai(runtime.client, params, runtime.log);
    const summary = `Analyzed ${result.imageCount} image(s).\nModel: ${result.model}${result.responseId ? `\nResponse: ${result.responseId}` : ""}\n\n${result.text}`;
    return {
      content: [{ type: "text", text: summary }],
      details: result,
    };
  },
});

const checkXaiHealthTool = defineTool({
  name: "check_xai_health",
  label: "check_xai_health",
  description:
    "Check xAI connectivity, auth, base URL, visible models, config source, settings namespace readiness.",
  promptSnippet: "check_xai_health() -> validate xAI auth/config and list sample models",
  parameters: Type.Object({}),
  async execute() {
    try {
      const result = await runXaiHealthCheck();
      return {
        content: [{ type: "text", text: xaiHealthSummary(result) }],
        details: result,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `xAI health failed.\n${summarizeError(error)}` }],
        details: undefined,
      };
    }
  },
});

const openXaiStudioTool = defineTool({
  name: "open_xai_studio",
  label: "open_xai_studio",
  description:
    "Open standalone native Glimpse studio for xAI image/video workflows. User can upload reference images, remix/generate images, edit selected image with text, convert selected image into video, then edit or extend videos.",
  promptSnippet: "open_xai_studio() -> native Glimpse xAI media studio with refs/edit/video flow",
  parameters: Type.Object({
    title: Type.Optional(Type.String({ description: "Optional window title." })),
  }),
  async execute(_toolCallId, params) {
    const runtime = createRuntime();
    await openXaiStudio({
      apiKey: runtime.apiKey,
      title: params.title?.trim() || "Pi xAI Imagine Studio",
    });
    return {
      content: [
        {
          type: "text",
          text: "Opened xAI studio window. Workflow: add refs, generate/remix image, edit selected image with text, animate into video, then edit/extend video.",
        },
      ],
      details: { ok: true },
    };
  },
});

export default function piXaiImagineExtension(pi: ExtensionAPI): void {
  pi.registerTool(generateImageTool);
  pi.registerTool(editImageTool);
  pi.registerTool(generateVideoTool);
  pi.registerTool(editVideoTool);
  pi.registerTool(extendVideoTool);
  pi.registerTool(understandImageTool);
  pi.registerTool(checkXaiHealthTool);
  pi.registerTool(openXaiStudioTool);

  pi.registerCommand("xai-health", {
    description: "Check xAI API health and config",
    handler: async (_args, ctx) => {
      try {
        const result = await runXaiHealthCheck();
        ctx.ui.notify(
          `xAI health OK · ${result.modelCount} models · ${result.apiKeySource}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`xAI health failed: ${summarizeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("xai-studio", {
    description: "Open native xAI media studio in Glimpse",
    handler: async (_args, ctx) => {
      try {
        const runtime = createRuntime();
        await openXaiStudio({ apiKey: runtime.apiKey, title: "Pi xAI Imagine Studio" });
        ctx.ui.notify("xAI studio opened", "info");
      } catch (error) {
        ctx.ui.notify(`Failed to open xAI studio: ${summarizeError(error)}`, "error");
      }
    },
  });
}
