import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { editImagesWithXai, generateImagesWithXai } from "./xai-image.ts";
import { editVideoWithXai, extendVideoWithXai, generateVideoWithXai } from "./xai-video.ts";
import {
  filePathToDataUri,
  filePathToFileUrl,
  summarizeError,
  type GeneratedImageAsset,
  type GeneratedVideoAsset,
  type XaiMediaLogger,
} from "./xai-media-shared.ts";

const GLIMPSE_PATH_OVERRIDE =
  process.env.PI_XAI_IMAGINE_GLIMPSE_PATH || process.env.PI_XAI_GEN_GLIMPSE_PATH;
const DEFAULT_GLIMPSE_MODULE_PATH = resolve(
  GLIMPSE_PATH_OVERRIDE || process.env.HOME || "",
  GLIMPSE_PATH_OVERRIDE ? "" : ".pi/agent/git/github.com/HazAT/glimpse/src/glimpse.mjs",
);
const STUDIO_WINDOWS = new Set<{ close?: () => void }>();

type StudioRefImage = {
  name: string;
  dataUrl: string;
  previewSrc: string;
};

type StudioImage = {
  path: string;
  inputSource: string;
  previewSrc: string;
  downloadSrc: string;
  sourceUrl?: string;
  originalPrompt?: string;
  revisedPrompt?: string;
  aspectRatio?: string;
};

type StudioVideo = {
  path: string;
  previewSrc: string;
  downloadSrc: string;
  sourceUrl?: string;
  duration?: number;
  respectModeration?: boolean;
  aspectRatio?: string;
};

type StudioMediaKind = "image" | "video";

type StudioBusyPreview = {
  kind: StudioMediaKind;
  previewSrc: string;
  aspectRatio?: string;
};

type StudioControls = {
  generateImage: {
    prompt: string;
    n: number;
    aspectRatio: string;
    resolution: string;
    quality: string;
    model: string;
  };
  editImage: {
    prompt: string;
    n: number;
    aspectRatio: string;
    resolution: string;
    quality: string;
    model: string;
  };
  generateVideo: {
    prompt: string;
    duration: number;
    aspectRatio: string;
    resolution: string;
    model: string;
    useReferences: boolean;
  };
  editVideo: {
    prompt: string;
    model: string;
  };
  extendVideo: {
    prompt: string;
    duration: number;
    model: string;
  };
};

type StudioState = {
  title: string;
  busy: boolean;
  status: string;
  error: string;
  referenceImages: StudioRefImage[];
  images: StudioImage[];
  selectedImageIndex: number;
  videos: StudioVideo[];
  selectedVideoIndex: number;
  currentMediaKind: StudioMediaKind;
  busyPreview?: StudioBusyPreview;
  controls: StudioControls;
};

type StudioMessage = {
  type?: string;
  index?: number;
  items?: Array<{ name?: string; dataUrl?: string }>;
  controls?: Partial<StudioControls>;
};

export interface OpenXaiStudioOptions {
  apiKey: string;
  title?: string;
  logger?: XaiMediaLogger;
  seedImages?: GeneratedImageAsset[];
  seedImageOriginalPrompt?: string;
  seedVideos?: GeneratedVideoAsset[];
  referenceImages?: Array<{ name?: string; dataUrl: string }>;
}

function defaultControls(): StudioControls {
  return {
    generateImage: {
      prompt: "",
      n: 1,
      aspectRatio: "auto",
      resolution: "2k",
      quality: "high",
      model: "",
    },
    editImage: {
      prompt: "",
      n: 1,
      aspectRatio: "auto",
      resolution: "2k",
      quality: "high",
      model: "",
    },
    generateVideo: {
      prompt: "",
      duration: 5,
      aspectRatio: "1:1",
      resolution: "720p",
      model: "",
      useReferences: true,
    },
    editVideo: {
      prompt: "",
      model: "",
    },
    extendVideo: {
      prompt: "",
      duration: 6,
      model: "",
    },
  };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.floor(index), length - 1));
}

function mergeControls(
  base: StudioControls,
  patch: Partial<StudioControls> | undefined,
): StudioControls {
  if (!patch) return base;
  return {
    generateImage: { ...base.generateImage, ...patch.generateImage },
    editImage: { ...base.editImage, ...patch.editImage },
    generateVideo: { ...base.generateVideo, ...patch.generateVideo },
    editVideo: { ...base.editVideo, ...patch.editVideo },
    extendVideo: { ...base.extendVideo, ...patch.extendVideo },
  };
}

function normalizeReferenceImages(
  items: Array<{ name?: string; dataUrl: string }> | undefined,
): StudioRefImage[] {
  const refs: StudioRefImage[] = [];
  for (const item of items ?? []) {
    const dataUrl = item.dataUrl?.trim();
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) continue;
    refs.push({
      name: item.name?.trim() || `reference-${refs.length + 1}`,
      dataUrl,
      previewSrc: dataUrl,
    });
    if (refs.length >= 5) break;
  }
  return refs;
}

function studioImageFromAsset(
  asset: GeneratedImageAsset,
  options?: { originalPrompt?: string; aspectRatio?: string },
): StudioImage {
  return {
    path: asset.path,
    inputSource: asset.path,
    previewSrc: filePathToDataUri(asset.path),
    downloadSrc: filePathToFileUrl(asset.path),
    sourceUrl: asset.sourceUrl,
    originalPrompt: options?.originalPrompt?.trim() || undefined,
    revisedPrompt: asset.revisedPrompt,
    aspectRatio: options?.aspectRatio,
  };
}

function pickVideoAspectRatio(
  currentImage: StudioImage | undefined,
  requestedAspectRatio: string,
): string {
  if (requestedAspectRatio === "1:1" && currentImage?.aspectRatio) {
    return currentImage.aspectRatio;
  }
  return requestedAspectRatio;
}

function studioVideoFromAsset(
  asset: GeneratedVideoAsset,
  options?: { aspectRatio?: string },
): StudioVideo {
  return {
    path: asset.path,
    previewSrc: filePathToDataUri(asset.path),
    downloadSrc: filePathToFileUrl(asset.path),
    sourceUrl: asset.sourceUrl,
    duration: asset.duration,
    respectModeration: asset.respectModeration,
    aspectRatio: options?.aspectRatio,
  };
}

function getSelectedImage(state: StudioState): StudioImage | undefined {
  return state.images[state.selectedImageIndex];
}

function getSelectedVideo(state: StudioState): StudioVideo | undefined {
  return state.videos[state.selectedVideoIndex];
}

function preferredMediaKind(state: StudioState): StudioMediaKind {
  if (state.currentMediaKind === "video" && state.videos.length) return "video";
  if (state.images.length) return "image";
  if (state.videos.length) return "video";
  return "image";
}

function aspectRatioToCss(value: string | undefined): string | undefined {
  const parts = String(value ?? "")
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.length !== 2 || !parts.every((part) => Number.isFinite(part) && part > 0)) {
    return undefined;
  }
  return `${String(parts[0])} / ${String(parts[1])}`;
}

function mediaFrameStyle(aspectRatio: string | undefined): string {
  const cssAspectRatio = aspectRatioToCss(aspectRatio);
  return cssAspectRatio ? ` style="aspect-ratio:${cssAspectRatio};"` : "";
}

function imageLightboxAttrs(downloadSrc: string, downloadName: string): string {
  return ` onclick='openImageLightboxFromImage(this, ${JSON.stringify(downloadSrc)}, ${JSON.stringify(downloadName)})'`;
}

function getBusyPreview(state: StudioState): StudioBusyPreview | undefined {
  return state.busy ? state.busyPreview : undefined;
}

function renderCurrentPreview(state: StudioState): string {
  const busyPreview = getBusyPreview(state);
  if (busyPreview) {
    return `<div class="media-frame loading"${mediaFrameStyle(busyPreview.aspectRatio)}>
						${busyPreview.kind === "video" ? `<video src="${busyPreview.previewSrc}" controls preload="auto" playsinline muted></video>` : `<img src="${busyPreview.previewSrc}" alt="Current selected image" />`}
						<div class="media-loading-badge">${escapeHtml(state.status || "Working...")}</div>
					</div>`;
  }

  const mediaKind = preferredMediaKind(state);
  const currentImage = getSelectedImage(state);
  const currentVideo = getSelectedVideo(state);
  if (mediaKind === "video" && currentVideo) {
    return `<div class="media-frame"${mediaFrameStyle(currentVideo.aspectRatio)}><video src="${currentVideo.previewSrc}" controls autoplay loop muted preload="auto" playsinline></video></div>`;
  }
  if (currentImage) {
    return `<div class="media-frame"${mediaFrameStyle(currentImage.aspectRatio)}><img src="${currentImage.previewSrc}" alt="Current selected image" class="click-zoom"${imageLightboxAttrs(currentImage.downloadSrc, fileName(currentImage.path))} /></div>`;
  }
  if (currentVideo) {
    return `<div class="media-frame"${mediaFrameStyle(currentVideo.aspectRatio)}><video src="${currentVideo.previewSrc}" controls autoplay loop muted preload="auto" playsinline></video></div>`;
  }
  return `<div class="empty">Select or generate image/video.</div>`;
}

function escapeHtml(value: string | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileName(filePath: string | undefined): string {
  const value = String(filePath ?? "").trim();
  return value ? basename(value) : "download";
}

function disabledAttr(disabled: boolean): string {
  return disabled ? ' disabled aria-disabled="true"' : "";
}

function checkedAttr(checked: boolean): string {
  return checked ? " checked" : "";
}

function selectedAttr(value: string, expected: string): string {
  return value === expected ? " selected" : "";
}

function renderReferenceStrip(state: StudioState): string {
  if (!state.referenceImages.length) {
    return `<div class="empty">No reference images yet. Add up to 5 for remix/edit/video guidance.</div>`;
  }
  return `<div class="thumb-strip">${state.referenceImages
    .map(
      (ref, index) => `
				<div class="thumb-card">
					<img src="${ref.previewSrc}" alt="${escapeHtml(ref.name)}" />
					<div class="thumb-meta">
						<div class="thumb-name">${escapeHtml(ref.name)}</div>
						<button class="ghost" ${disabledAttr(state.busy)} onclick="removeReference(${index})">Remove</button>
					</div>
				</div>`,
    )
    .join("")}</div>`;
}

function renderImageGrid(state: StudioState): string {
  if (!state.images.length) {
    return `<div class="empty">No generated images yet.</div>`;
  }
  return `<div class="grid">${state.images
    .map((image, index) => {
      const selected = index === state.selectedImageIndex;
      return `
				<div class="card ${selected ? "selected" : ""}">
					<div class="media-frame"${mediaFrameStyle(image.aspectRatio)}>
						<img src="${image.previewSrc}" alt="Generated image ${index + 1}" class="click-zoom" onclick="selectImage(${index})"${imageLightboxAttrs(image.downloadSrc, fileName(image.path))} />
					</div>
					<div class="card-meta">
						<div class="card-title">Image ${index + 1}</div>
						${image.originalPrompt ? `<div class="card-note"><strong>Original prompt:</strong> ${escapeHtml(image.originalPrompt)}</div>` : ""}
						${image.revisedPrompt ? `<div class="card-note"><strong>Revised prompt:</strong> ${escapeHtml(image.revisedPrompt)}</div>` : ""}
						<div class="toolbar">
							<button class="ghost" ${disabledAttr(state.busy)} onclick="selectImage(${index})">${selected ? "Selected" : "Use this"}</button>
							<a class="link-button ghost" href="${image.downloadSrc}" download="${escapeHtml(fileName(image.path))}">Download</a>
						</div>
					</div>
				</div>`;
    })
    .join("")}</div>`;
}

function renderVideoGrid(state: StudioState): string {
  if (!state.videos.length) {
    return `<div class="empty">No videos yet.</div>`;
  }
  return `<div class="video-list">${state.videos
    .map((video, index) => {
      const selected = index === state.selectedVideoIndex;
      return `
				<div class="video-card ${selected ? "selected" : ""}">
					<div class="media-frame"${mediaFrameStyle(video.aspectRatio)}>
						<video src="${video.previewSrc}" controls preload="auto" playsinline></video>
					</div>
					<div class="card-meta">
						<div class="card-title">Video ${index + 1}${video.duration ? ` · ${escapeHtml(String(video.duration))}s` : ""}</div>
						<div class="card-note">${video.sourceUrl ? "Editable/extendable via xAI URL available." : "Local file only."}</div>
						<div class="toolbar">
							<button class="ghost" ${disabledAttr(state.busy)} onclick="selectVideo(${index})">${selected ? "Selected" : "Use this"}</button>
							<a class="link-button ghost" href="${video.downloadSrc}" download="${escapeHtml(fileName(video.path))}">Download</a>
						</div>
					</div>
				</div>`;
    })
    .join("")}</div>`;
}

function renderStudioHtml(state: StudioState): string {
  const currentImage = getSelectedImage(state);
  const currentVideo = getSelectedVideo(state);
  const currentMediaKind = preferredMediaKind(state);
  return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(state.title)}</title>
	<style>
		:root {
			color-scheme: dark;
			--bg: #0b1020;
			--panel: rgba(15, 23, 42, 0.88);
			--panel-2: rgba(30, 41, 59, 0.76);
			--line: rgba(148, 163, 184, 0.22);
			--text: #e5eefb;
			--muted: #93a4bf;
			--accent: #4da3ff;
			--accent-2: #c066ff;
			--danger: #ff6b81;
			--success: #34d399;
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			background:
				radial-gradient(circle at top left, rgba(77,163,255,0.22), transparent 28%),
				radial-gradient(circle at top right, rgba(192,102,255,0.18), transparent 24%),
				linear-gradient(180deg, #08111f 0%, #0b1020 100%);
			color: var(--text);
		}
		main {
			padding: 20px;
			display: grid;
			grid-template-columns: minmax(380px, 460px) minmax(0, 1fr);
			gap: 18px;
			min-height: 100vh;
		}
		.panel {
			background: var(--panel);
			border: 1px solid var(--line);
			border-radius: 18px;
			backdrop-filter: blur(18px);
			box-shadow: 0 24px 80px rgba(0,0,0,0.3);
		}
		.sidebar { padding: 18px; display: flex; flex-direction: column; gap: 16px; }
		.content { padding: 18px; display: flex; flex-direction: column; gap: 18px; }
		h1, h2, h3, p { margin: 0; }
		h1 { font-size: 24px; }
		h2 { font-size: 16px; margin-bottom: 10px; }
		p.subtle, .subtle { color: var(--muted); font-size: 13px; }
		section.block {
			padding: 14px;
			background: var(--panel-2);
			border: 1px solid var(--line);
			border-radius: 14px;
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
		label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
		input[type="text"], input[type="number"], textarea, select {
			width: 100%;
			background: rgba(15, 23, 42, 0.72);
			color: var(--text);
			border: 1px solid rgba(148, 163, 184, 0.24);
			border-radius: 10px;
			padding: 10px 12px;
			font: inherit;
		}
		textarea { min-height: 82px; resize: vertical; }
		.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
		.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
		button {
			border: 0;
			border-radius: 10px;
			padding: 10px 12px;
			font: inherit;
			font-weight: 600;
			cursor: pointer;
			background: linear-gradient(135deg, var(--accent), var(--accent-2));
			color: white;
		}
		button.ghost, a.link-button.ghost {
			background: rgba(148, 163, 184, 0.12);
			color: var(--text);
			border: 1px solid rgba(148, 163, 184, 0.18);
		}
		button.warn {
			background: rgba(255, 107, 129, 0.16);
			border: 1px solid rgba(255, 107, 129, 0.25);
			color: #ffd6de;
		}
		button.secondary {
			background: linear-gradient(135deg, rgba(77,163,255,0.16), rgba(192,102,255,0.18));
			border: 1px solid rgba(77,163,255,0.28);
			color: var(--text);
		}
		a.link-button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			text-decoration: none;
			border-radius: 10px;
			padding: 10px 12px;
			font: inherit;
			font-weight: 600;
		}
		button:disabled { opacity: 0.45; cursor: not-allowed; }
		.toolbar { display: flex; gap: 10px; flex-wrap: wrap; }
		.upload-input {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 10px;
			border-radius: 999px;
			font-size: 12px;
			background: rgba(77,163,255,0.14);
			border: 1px solid rgba(77,163,255,0.24);
		}
		.badge.error {
			background: rgba(255,107,129,0.14);
			border-color: rgba(255,107,129,0.26);
		}
		.thumb-strip, .grid, .video-list {
			display: grid;
			gap: 12px;
		}
		.thumb-strip { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
		.grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
		.video-list { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
		.thumb-card, .card, .video-card {
			background: rgba(15, 23, 42, 0.72);
			border: 1px solid rgba(148, 163, 184, 0.18);
			border-radius: 14px;
			overflow: hidden;
		}
		.card.selected, .video-card.selected { border-color: rgba(77,163,255,0.7); box-shadow: 0 0 0 1px rgba(77,163,255,0.4) inset; }
		.thumb-card img {
			display: block;
			width: 100%;
			height: 140px;
			object-fit: cover;
			background: #050814;
		}
		.card .media-frame, .video-card .media-frame {
			min-height: 220px;
		}
		.card-meta, .thumb-meta {
			padding: 10px;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.card-title, .thumb-name { font-size: 13px; font-weight: 700; }
		.card-path, .card-note { font-size: 12px; color: var(--muted); word-break: break-word; }
		.card-note strong { color: var(--text); }
		.empty {
			padding: 20px;
			border-radius: 14px;
			border: 1px dashed rgba(148,163,184,0.22);
			color: var(--muted);
			text-align: center;
		}
		.current-preview {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
			gap: 14px;
			align-items: start;
		}
		.hero {
			background: rgba(15,23,42,0.72);
			border: 1px solid rgba(148,163,184,0.18);
			border-radius: 16px;
			overflow: hidden;
		}
		.media-frame {
			position: relative;
			width: 100%;
			background: #050814;
		}
		.media-frame img, .media-frame video {
			display: block;
			width: 100%;
			height: 100%;
			max-height: 520px;
			object-fit: contain;
			background: #050814;
		}
		.media-frame.loading img, .media-frame.loading video {
			filter: blur(18px) saturate(0.8);
			transform: scale(1.02);
		}
		.media-loading-badge {
			position: absolute;
			left: 50%;
			top: 50%;
			transform: translate(-50%, -50%);
			padding: 12px 16px;
			border-radius: 999px;
			background: rgba(5, 8, 20, 0.72);
			border: 1px solid rgba(148,163,184,0.18);
			backdrop-filter: blur(10px);
			font-size: 13px;
			font-weight: 700;
			box-shadow: 0 14px 40px rgba(0,0,0,0.28);
		}
		.stat {
			padding: 12px;
			border-radius: 12px;
			background: rgba(148, 163, 184, 0.1);
			border: 1px solid rgba(148,163,184,0.16);
			font-size: 13px;
		}
		.dropzone {
			padding: 16px;
			border-radius: 14px;
			border: 1px dashed rgba(77,163,255,0.36);
			background: linear-gradient(180deg, rgba(77,163,255,0.08), rgba(192,102,255,0.06));
			display: flex;
			flex-direction: column;
			gap: 10px;
			transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
		}
		.dropzone.active {
			border-color: rgba(77,163,255,0.82);
			background: linear-gradient(180deg, rgba(77,163,255,0.16), rgba(192,102,255,0.12));
			transform: scale(1.01);
		}
		.dropzone-title { font-size: 13px; font-weight: 700; }
		.dropzone-copy { font-size: 12px; color: var(--muted); }
		.checkline { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
		.checkline input { width: 16px; height: 16px; }
		.overlay {
			position: fixed;
			inset: 0;
			background: rgba(5, 8, 20, 0.58);
			backdrop-filter: blur(6px);
			display: ${state.busy ? "flex" : "none"};
			align-items: center;
			justify-content: center;
			font-size: 18px;
			font-weight: 700;
			z-index: 40;
		}
		.lightbox {
			position: fixed;
			inset: 0;
			background: rgba(3, 6, 18, 0.92);
			backdrop-filter: blur(10px);
			display: none;
			align-items: center;
			justify-content: center;
			padding: 24px;
			z-index: 60;
		}
		.lightbox.open {
			display: flex;
		}
		.lightbox-panel {
			width: min(96vw, 1600px);
			height: min(94vh, 1100px);
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.lightbox-toolbar {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 12px;
		}
		.lightbox-media {
			flex: 1;
			background: rgba(15, 23, 42, 0.72);
			border: 1px solid rgba(148,163,184,0.18);
			border-radius: 18px;
			overflow: hidden;
			display: flex;
			align-items: center;
			justify-content: center;
		}
		.lightbox-media img {
			display: block;
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
			background: #050814;
		}
		input[type="file"]#ref-upload {
			-webkit-appearance: none;
			appearance: none;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 10px 12px;
			font: inherit;
			font-weight: 600;
			border-radius: 10px;
			background: linear-gradient(135deg, rgba(77,163,255,0.16), rgba(192,102,255,0.18));
			border: 1px solid rgba(77,163,255,0.28);
			color: var(--text);
			cursor: pointer;
			width: auto;
			font-size: 0;
		}
		input[type="file"]#ref-upload::-webkit-file-upload-button {
			-webkit-appearance: none;
			appearance: none;
			background: transparent;
			border: none;
			color: var(--text);
			font: inherit;
			font-weight: 600;
			cursor: pointer;
			font-size: 14px;
		}
		@media (max-width: 1180px) {
			main { grid-template-columns: 1fr; }
			.current-preview { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<div class="overlay">${escapeHtml(state.status || "Working...")}</div>
	<div id="image-lightbox" class="lightbox" onclick="handleImageLightboxBackdrop(event)">
		<div class="lightbox-panel">
			<div class="lightbox-toolbar">
				<div id="image-lightbox-title" class="badge">Image preview</div>
				<div class="toolbar">
					<a id="image-lightbox-download" class="link-button ghost" href="#" download="image">Download</a>
					<button onclick="closeImageLightbox()">Close</button>
				</div>
			</div>
			<div class="lightbox-media">
				<img id="image-lightbox-img" src="" alt="Fullscreen preview" />
			</div>
		</div>
	</div>
	<main>
		<aside class="panel sidebar">
			<div>
				<h1>${escapeHtml(state.title)}</h1>
				<p class="subtle">Standalone xAI media studio. Generate/remix image, edit with text, animate into video, then edit/extend clips.</p>
			</div>
			<div class="toolbar">
				<div class="badge">${escapeHtml(state.status || "Ready")}</div>
				${state.error ? `<div class="badge error">${escapeHtml(state.error)}</div>` : ""}
			</div>
			<section class="block">
				<h2>Reference images</h2>
				<p class="subtle">Grok-style remix input. Drag/drop images or use picker button. Add up to 5 refs for remix/edit/video guidance.</p>
				<div
					id="ref-dropzone"
					class="dropzone"
					ondragenter="activateDropzone(event)"
					ondragover="activateDropzone(event)"
					ondragleave="deactivateDropzone(event)"
					ondrop="handleReferenceDrop(event)">
					<div class="dropzone-title">Drop reference images here</div>
					<div class="dropzone-copy">PNG, JPG, WEBP, GIF. Studio converts files to data URLs before sending.</div>
					<div class="toolbar">
						<input id="ref-upload" type="file" accept="image/*" multiple ${disabledAttr(state.busy)} onchange="uploadReferences(this)" />
						<button class="ghost" ${disabledAttr(state.busy || !state.referenceImages.length)} onclick="clearReferences()">Clear refs</button>
					</div>
				</div>
				<div class="toolbar">
					<div class="badge">${state.referenceImages.length}/5 refs loaded</div>
				</div>
				${renderReferenceStrip(state)}
			</section>
			<section class="block">
				<h2>Generate / remix image</h2>
				<label for="gi-prompt">Prompt</label>
				<textarea id="gi-prompt" placeholder="Describe image or remix goal">${escapeHtml(state.controls.generateImage.prompt)}</textarea>
				<div class="grid-3">
					<div><label for="gi-n">Count</label><input id="gi-n" type="number" min="1" max="10" value="${escapeHtml(String(state.controls.generateImage.n))}" /></div>
					<div><label for="gi-ar">Aspect</label><select id="gi-ar">
						<option value="1:1"${selectedAttr(state.controls.generateImage.aspectRatio, "1:1")}>1:1</option>
						<option value="16:9"${selectedAttr(state.controls.generateImage.aspectRatio, "16:9")}>16:9</option>
						<option value="9:16"${selectedAttr(state.controls.generateImage.aspectRatio, "9:16")}>9:16</option>
						<option value="4:3"${selectedAttr(state.controls.generateImage.aspectRatio, "4:3")}>4:3</option>
						<option value="3:4"${selectedAttr(state.controls.generateImage.aspectRatio, "3:4")}>3:4</option>
						<option value="3:2"${selectedAttr(state.controls.generateImage.aspectRatio, "3:2")}>3:2</option>
						<option value="2:3"${selectedAttr(state.controls.generateImage.aspectRatio, "2:3")}>2:3</option>
						<option value="auto"${selectedAttr(state.controls.generateImage.aspectRatio, "auto")}>auto</option>
					</select></div>
					<div><label for="gi-res">Resolution</label><select id="gi-res">
						<option value="1k"${selectedAttr(state.controls.generateImage.resolution, "1k")}>1k</option>
						<option value="2k"${selectedAttr(state.controls.generateImage.resolution, "2k")}>2k</option>
					</select></div>
				</div>
				<div class="grid-2">
					<div><label for="gi-quality">Quality</label><select id="gi-quality">
						<option value="low"${selectedAttr(state.controls.generateImage.quality, "low")}>low</option>
						<option value="medium"${selectedAttr(state.controls.generateImage.quality, "medium")}>medium</option>
						<option value="high"${selectedAttr(state.controls.generateImage.quality, "high")}>high</option>
					</select></div>
					<div><label for="gi-model">Model override</label><input id="gi-model" type="text" placeholder="grok-imagine-image" value="${escapeHtml(state.controls.generateImage.model)}" /></div>
				</div>
				<button ${disabledAttr(state.busy)} onclick="sendAction('generateImage')">Generate image${state.referenceImages.length ? " / remix refs" : ""}</button>
			</section>
			<section class="block">
				<h2>Edit selected image with text</h2>
				<p class="subtle">Uses current selected image. Reference images appended when present.</p>
				<label for="ei-prompt">Edit prompt</label>
				<textarea id="ei-prompt" placeholder="What should change?">${escapeHtml(state.controls.editImage.prompt)}</textarea>
				<div class="grid-3">
					<div><label for="ei-n">Count</label><input id="ei-n" type="number" min="1" max="10" value="${escapeHtml(String(state.controls.editImage.n))}" /></div>
					<div><label for="ei-ar">Aspect</label><select id="ei-ar">
						<option value="1:1"${selectedAttr(state.controls.editImage.aspectRatio, "1:1")}>1:1</option>
						<option value="16:9"${selectedAttr(state.controls.editImage.aspectRatio, "16:9")}>16:9</option>
						<option value="9:16"${selectedAttr(state.controls.editImage.aspectRatio, "9:16")}>9:16</option>
						<option value="4:3"${selectedAttr(state.controls.editImage.aspectRatio, "4:3")}>4:3</option>
						<option value="3:4"${selectedAttr(state.controls.editImage.aspectRatio, "3:4")}>3:4</option>
						<option value="3:2"${selectedAttr(state.controls.editImage.aspectRatio, "3:2")}>3:2</option>
						<option value="2:3"${selectedAttr(state.controls.editImage.aspectRatio, "2:3")}>2:3</option>
						<option value="auto"${selectedAttr(state.controls.editImage.aspectRatio, "auto")}>auto</option>
					</select></div>
					<div><label for="ei-res">Resolution</label><select id="ei-res">
						<option value="1k"${selectedAttr(state.controls.editImage.resolution, "1k")}>1k</option>
						<option value="2k"${selectedAttr(state.controls.editImage.resolution, "2k")}>2k</option>
					</select></div>
				</div>
				<div class="grid-2">
					<div><label for="ei-quality">Quality</label><select id="ei-quality">
						<option value="low"${selectedAttr(state.controls.editImage.quality, "low")}>low</option>
						<option value="medium"${selectedAttr(state.controls.editImage.quality, "medium")}>medium</option>
						<option value="high"${selectedAttr(state.controls.editImage.quality, "high")}>high</option>
					</select></div>
					<div><label for="ei-model">Model override</label><input id="ei-model" type="text" placeholder="grok-imagine-image" value="${escapeHtml(state.controls.editImage.model)}" /></div>
				</div>
				<button ${disabledAttr(state.busy || !currentImage)} onclick="sendAction('editImage')">Edit selected image</button>
			</section>
			<section class="block">
				<h2>Animate image into video</h2>
				<label for="gv-prompt">Video prompt</label>
				<textarea id="gv-prompt" placeholder="Describe motion, camera, mood">${escapeHtml(state.controls.generateVideo.prompt)}</textarea>
				<div class="grid-3">
					<div><label for="gv-duration">Duration</label><input id="gv-duration" type="number" min="1" max="15" value="${escapeHtml(String(state.controls.generateVideo.duration))}" /></div>
					<div><label for="gv-ar">Aspect</label><select id="gv-ar">
						<option value="1:1"${selectedAttr(state.controls.generateVideo.aspectRatio, "1:1")}>1:1</option>
						<option value="16:9"${selectedAttr(state.controls.generateVideo.aspectRatio, "16:9")}>16:9</option>
						<option value="9:16"${selectedAttr(state.controls.generateVideo.aspectRatio, "9:16")}>9:16</option>
						<option value="4:3"${selectedAttr(state.controls.generateVideo.aspectRatio, "4:3")}>4:3</option>
						<option value="3:4"${selectedAttr(state.controls.generateVideo.aspectRatio, "3:4")}>3:4</option>
						<option value="3:2"${selectedAttr(state.controls.generateVideo.aspectRatio, "3:2")}>3:2</option>
						<option value="2:3"${selectedAttr(state.controls.generateVideo.aspectRatio, "2:3")}>2:3</option>
					</select></div>
					<div><label for="gv-res">Resolution</label><select id="gv-res">
						<option value="480p"${selectedAttr(state.controls.generateVideo.resolution, "480p")}>480p</option>
						<option value="720p"${selectedAttr(state.controls.generateVideo.resolution, "720p")}>720p</option>
					</select></div>
				</div>
				<div class="grid-2">
					<div><label for="gv-model">Model override</label><input id="gv-model" type="text" placeholder="grok-imagine-video" value="${escapeHtml(state.controls.generateVideo.model)}" /></div>
					<div class="checkline"><input id="gv-use-refs" type="checkbox"${checkedAttr(state.controls.generateVideo.useReferences)} /><span>Use refs as extra guidance</span></div>
				</div>
				<button ${disabledAttr(state.busy)} onclick="sendAction('generateVideo')">Generate video${currentImage ? " from selected image" : " from prompt"}</button>
			</section>
			<section class="block">
				<h2>Edit / extend selected video</h2>
				<p class="subtle">Needs xAI/public source URL. Generated videos keep it.</p>
				<label for="ev-prompt">Edit prompt</label>
				<textarea id="ev-prompt" placeholder="How should selected clip change?">${escapeHtml(state.controls.editVideo.prompt)}</textarea>
				<label for="ev-model">Model override</label>
				<input id="ev-model" type="text" placeholder="grok-imagine-video" value="${escapeHtml(state.controls.editVideo.model)}" />
				<div class="toolbar">
					<button ${disabledAttr(state.busy || !currentVideo || !currentVideo.sourceUrl)} onclick="sendAction('editVideo')">Edit video</button>
				</div>
				<label for="xv-prompt">Extend prompt</label>
				<textarea id="xv-prompt" placeholder="What happens next?">${escapeHtml(state.controls.extendVideo.prompt)}</textarea>
				<div class="grid-2">
					<div><label for="xv-duration">Extra seconds</label><input id="xv-duration" type="number" min="2" max="10" value="${escapeHtml(String(state.controls.extendVideo.duration))}" /></div>
					<div><label for="xv-model">Model override</label><input id="xv-model" type="text" placeholder="grok-imagine-video" value="${escapeHtml(state.controls.extendVideo.model)}" /></div>
				</div>
				<button ${disabledAttr(state.busy || !currentVideo || !currentVideo.sourceUrl)} onclick="sendAction('extendVideo')">Extend video</button>
			</section>
		</aside>
		<section class="panel content">
			<section class="block">
				<h2>Current selection</h2>
				<div class="current-preview">
					<div class="hero">
						${renderCurrentPreview(state)}
					</div>
					<div style="display:flex; flex-direction:column; gap:10px;">
						<div class="stat"><strong>Current preview:</strong><br />${escapeHtml(currentMediaKind === "video" ? "Video" : "Image")}${state.busy ? " · updating…" : ""}</div>
						<div class="stat"><strong>Selected image:</strong><br />${currentImage ? escapeHtml(fileName(currentImage.path)) : "None"}${currentImage ? `<div class="toolbar" style="margin-top:8px;"><a class="link-button ghost" href="${currentImage.downloadSrc}" download="${escapeHtml(fileName(currentImage.path))}">Download image</a></div>` : ""}</div>
						<div class="stat"><strong>Original prompt:</strong><br />${currentImage?.originalPrompt ? escapeHtml(currentImage.originalPrompt) : "None recorded yet"}</div>
						<div class="stat"><strong>Revised prompt:</strong><br />${currentImage?.revisedPrompt ? escapeHtml(currentImage.revisedPrompt) : "None"}</div>
						<div class="stat"><strong>Selected video:</strong><br />${currentVideo ? escapeHtml(fileName(currentVideo.path)) : "None"}${currentVideo ? `<div class="toolbar" style="margin-top:8px;"><a class="link-button ghost" href="${currentVideo.downloadSrc}" download="${escapeHtml(fileName(currentVideo.path))}">Download video</a></div>` : ""}</div>
						<div class="stat"><strong>Workflow:</strong><br />Upload refs → generate/remix image → edit selected image → animate to video.</div>
					</div>
				</div>
			</section>
			<section class="block">
				<h2>Generated images</h2>
				${renderImageGrid(state)}
			</section>
			<section class="block">
				<h2>Videos</h2>
				${renderVideoGrid(state)}
			</section>
		</section>
	</main>
	<script>
		function valueOf(id) { const el = document.getElementById(id); return el ? el.value : ''; }
		function numberOf(id, fallback) { const raw = Number(valueOf(id)); return Number.isFinite(raw) ? raw : fallback; }
		function boolOf(id) { const el = document.getElementById(id); return !!(el && el.checked); }
		function collectControls() {
			return {
				generateImage: {
					prompt: valueOf('gi-prompt'),
					n: numberOf('gi-n', 1),
					aspectRatio: valueOf('gi-ar') || 'auto',
					resolution: valueOf('gi-res') || '2k',
					quality: valueOf('gi-quality') || 'high',
					model: valueOf('gi-model'),
				},
				editImage: {
					prompt: valueOf('ei-prompt'),
					n: numberOf('ei-n', 1),
					aspectRatio: valueOf('ei-ar') || 'auto',
					resolution: valueOf('ei-res') || '2k',
					quality: valueOf('ei-quality') || 'high',
					model: valueOf('ei-model'),
				},
				generateVideo: {
					prompt: valueOf('gv-prompt'),
					duration: numberOf('gv-duration', 5),
					aspectRatio: valueOf('gv-ar') || '1:1',
					resolution: valueOf('gv-res') || '720p',
					model: valueOf('gv-model'),
					useReferences: boolOf('gv-use-refs'),
				},
				editVideo: {
					prompt: valueOf('ev-prompt'),
					model: valueOf('ev-model'),
				},
				extendVideo: {
					prompt: valueOf('xv-prompt'),
					duration: numberOf('xv-duration', 6),
					model: valueOf('xv-model'),
				},
			};
		}
		function send(message) { window.glimpse.send(message); }
		function openImageLightboxFromImage(img, downloadSrc, downloadName) {
			const modal = document.getElementById('image-lightbox');
			const modalImg = document.getElementById('image-lightbox-img');
			const modalDownload = document.getElementById('image-lightbox-download');
			const modalTitle = document.getElementById('image-lightbox-title');
			if (!modal || !modalImg || !modalDownload || !modalTitle || !img) return;
			modalImg.src = img.currentSrc || img.src || '';
			modalDownload.href = downloadSrc || img.currentSrc || img.src || '#';
			modalDownload.download = downloadName || 'image';
			modalTitle.textContent = downloadName || 'Image preview';
			modal.classList.add('open');
		}
		function closeImageLightbox() {
			const modal = document.getElementById('image-lightbox');
			if (modal) modal.classList.remove('open');
		}
		function handleImageLightboxBackdrop(event) {
			if (event.target && event.target.id === 'image-lightbox') closeImageLightbox();
		}
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') closeImageLightbox();
		});
		function sendAction(type, extra) { send(Object.assign({ type, controls: collectControls() }, extra || {})); }
		async function uploadReferences(input) {
			await uploadReferenceFiles(Array.from(input.files || []));
			input.value = '';
		}
		async function uploadReferenceFiles(files) {
			const imageFiles = files.filter((file) => String(file.type || '').startsWith('image/')).slice(0, 5);
			if (!imageFiles.length) return;
			const items = await Promise.all(imageFiles.map(fileToDataUrl));
			send({ type: 'setReferences', items, controls: collectControls() });
		}
		function fileToDataUrl(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result || '') });
				reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
				reader.readAsDataURL(file);
			});
		}
		function activateDropzone(event) {
			event.preventDefault();
			const zone = document.getElementById('ref-dropzone');
			if (zone) zone.classList.add('active');
		}
		function deactivateDropzone(event) {
			event.preventDefault();
			const zone = document.getElementById('ref-dropzone');
			if (!zone) return;
			const next = event.relatedTarget;
			if (next && zone.contains(next)) return;
			zone.classList.remove('active');
		}
		async function handleReferenceDrop(event) {
			event.preventDefault();
			const zone = document.getElementById('ref-dropzone');
			if (zone) zone.classList.remove('active');
			const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
			await uploadReferenceFiles(files);
		}
		function removeReference(index) { sendAction('removeReference', { index }); }
		function clearReferences() { sendAction('clearReferences'); }
		function selectImage(index) { sendAction('selectImage', { index }); }
		function selectVideo(index) { sendAction('selectVideo', { index }); }
	</script>
</body>
</html>`;
}

async function loadGlimpseOpen(): Promise<
  (html: string, options?: Record<string, unknown>) => any
> {
  if (!existsSync(DEFAULT_GLIMPSE_MODULE_PATH)) {
    throw new Error(
      `Glimpse not found at ${DEFAULT_GLIMPSE_MODULE_PATH}. Install glimpse or set PI_XAI_IMAGINE_GLIMPSE_PATH to glimpse/src/glimpse.mjs. Legacy PI_XAI_GEN_GLIMPSE_PATH still works.`,
    );
  }
  const mod = (await import(pathToFileURL(DEFAULT_GLIMPSE_MODULE_PATH).href)) as {
    open?: (html: string, options?: Record<string, unknown>) => any;
  };
  if (typeof mod.open !== "function") {
    throw new Error("Glimpse module loaded, but open() export missing.");
  }
  return mod.open;
}

export async function openXaiStudio(options: OpenXaiStudioOptions): Promise<void> {
  const open = await loadGlimpseOpen();
  const state: StudioState = {
    title: options.title?.trim() || "Pi xAI Imagine Studio",
    busy: false,
    status: "Ready",
    error: "",
    referenceImages: normalizeReferenceImages(options.referenceImages),
    images: (options.seedImages ?? []).map((image) =>
      studioImageFromAsset(image, {
        originalPrompt: options.seedImageOriginalPrompt,
      }),
    ),
    selectedImageIndex: 0,
    videos: (options.seedVideos ?? []).map((video) => studioVideoFromAsset(video)),
    selectedVideoIndex: 0,
    currentMediaKind: options.seedImages?.length ? "image" : "video",
    busyPreview: undefined,
    controls: defaultControls(),
  };
  const win = open(renderStudioHtml(state), {
    width: 1440,
    height: 980,
    title: state.title,
    openLinks: true,
  });
  STUDIO_WINDOWS.add(win);

  const rerender = () => {
    state.selectedImageIndex = clampIndex(state.selectedImageIndex, state.images.length);
    state.selectedVideoIndex = clampIndex(state.selectedVideoIndex, state.videos.length);
    win.setHTML(renderStudioHtml(state));
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    state.busy = true;
    state.status = label;
    state.error = "";
    rerender();
    try {
      await fn();
    } catch (error) {
      state.error = summarizeError(error);
      options.logger?.error?.(`[xai-studio] ${state.error}`);
    } finally {
      state.busy = false;
      state.busyPreview = undefined;
      rerender();
    }
  };

  const handleGenerateImage = async () => {
    const params = state.controls.generateImage;
    const refSources = state.referenceImages.map((ref) => ref.dataUrl);
    if (refSources.length) {
      const result = await editImagesWithXai(
        options.apiKey,
        {
          prompt: params.prompt,
          n: params.n,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          quality: params.quality,
          model: params.model || undefined,
          images: refSources,
        },
        options.logger,
      );
      state.images = result.images.map((image) =>
        studioImageFromAsset(image, {
          originalPrompt: params.prompt,
          aspectRatio: params.aspectRatio,
        }),
      );
      state.selectedImageIndex = 0;
      state.currentMediaKind = "image";
      state.status = `Remixed ${result.count} image(s) with ${result.model}.`;
      return;
    }

    const result = await generateImagesWithXai(
      options.apiKey,
      {
        prompt: params.prompt,
        n: params.n,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        quality: params.quality,
        model: params.model || undefined,
      },
      options.logger,
    );
    state.images = result.images.map((image) =>
      studioImageFromAsset(image, {
        originalPrompt: params.prompt,
        aspectRatio: params.aspectRatio,
      }),
    );
    state.selectedImageIndex = 0;
    state.currentMediaKind = "image";
    state.status = `Generated ${result.count} image(s) with ${result.model}.`;
  };

  const handleEditImage = async () => {
    const currentImage = getSelectedImage(state);
    if (!currentImage) {
      throw new Error("No selected image. Generate or select image first.");
    }
    const params = state.controls.editImage;
    const refSources = state.referenceImages.map((ref) => ref.dataUrl);
    const result = await editImagesWithXai(
      options.apiKey,
      {
        prompt: params.prompt,
        n: params.n,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        quality: params.quality,
        model: params.model || undefined,
        images: [currentImage.inputSource, ...refSources].slice(0, 5),
      },
      options.logger,
    );
    state.images = result.images.map((image) =>
      studioImageFromAsset(image, {
        originalPrompt: params.prompt,
        aspectRatio: params.aspectRatio,
      }),
    );
    state.selectedImageIndex = 0;
    state.currentMediaKind = "image";
    state.status = `Edited ${result.count} image(s) with ${result.model}.`;
  };

  const handleGenerateVideo = async () => {
    const currentImage = getSelectedImage(state);
    const params = state.controls.generateVideo;
    const aspectRatio = pickVideoAspectRatio(currentImage, params.aspectRatio);
    const useReferenceMode = !currentImage && params.useReferences;
    const refSources = useReferenceMode ? state.referenceImages.map((ref) => ref.dataUrl) : [];
    const result = await generateVideoWithXai(
      options.apiKey,
      {
        prompt: params.prompt,
        duration: params.duration,
        aspectRatio,
        resolution: params.resolution,
        model: params.model || undefined,
        image: useReferenceMode ? undefined : currentImage?.inputSource,
        referenceImages: refSources,
      },
      options.logger,
    );
    const ignoredRefsNote =
      currentImage && params.useReferences && state.referenceImages.length
        ? " Refs ignored because xAI forbids image + reference_images in same request."
        : "";
    state.videos = [studioVideoFromAsset(result.video, { aspectRatio }), ...state.videos].slice(
      0,
      8,
    );
    state.selectedVideoIndex = 0;
    state.currentMediaKind = "video";
    state.status = `Generated video ${result.requestId} with ${result.model}.${ignoredRefsNote}`;
  };

  const handleEditVideo = async () => {
    const currentVideo = getSelectedVideo(state);
    if (!currentVideo?.sourceUrl) {
      throw new Error(
        "Selected video missing xAI/public source URL. Use generated clip or public URL-backed clip.",
      );
    }
    const params = state.controls.editVideo;
    const result = await editVideoWithXai(
      options.apiKey,
      {
        prompt: params.prompt,
        videoUrl: currentVideo.sourceUrl,
        model: params.model || undefined,
      },
      options.logger,
    );
    state.videos = [
      studioVideoFromAsset(result.video, { aspectRatio: currentVideo.aspectRatio }),
      ...state.videos,
    ].slice(0, 8);
    state.selectedVideoIndex = 0;
    state.currentMediaKind = "video";
    state.status = `Edited video ${result.requestId} with ${result.model}.`;
  };

  const handleExtendVideo = async () => {
    const currentVideo = getSelectedVideo(state);
    if (!currentVideo?.sourceUrl) {
      throw new Error(
        "Selected video missing xAI/public source URL. Use generated clip or public URL-backed clip.",
      );
    }
    const params = state.controls.extendVideo;
    const result = await extendVideoWithXai(
      options.apiKey,
      {
        prompt: params.prompt,
        videoUrl: currentVideo.sourceUrl,
        duration: params.duration,
        model: params.model || undefined,
      },
      options.logger,
    );
    state.videos = [
      studioVideoFromAsset(result.video, { aspectRatio: currentVideo.aspectRatio }),
      ...state.videos,
    ].slice(0, 8);
    state.selectedVideoIndex = 0;
    state.currentMediaKind = "video";
    state.status = `Extended video ${result.requestId} with ${result.model}.`;
  };

  win.on("message", (raw: StudioMessage | undefined) => {
    void (async () => {
      const data = raw ?? {};
      state.controls = mergeControls(state.controls, data.controls);
      switch (data.type) {
        case "setReferences": {
          const refs = normalizeReferenceImages(
            (data.items ?? []).map((item) => ({ name: item.name, dataUrl: item.dataUrl || "" })),
          );
          state.referenceImages = [...state.referenceImages, ...refs].slice(0, 5);
          state.status = `${state.referenceImages.length} reference image(s) loaded.`;
          rerender();
          break;
        }
        case "removeReference": {
          const index = clampIndex(Number(data.index ?? 0), state.referenceImages.length);
          state.referenceImages.splice(index, 1);
          state.status = state.referenceImages.length
            ? `${state.referenceImages.length} reference image(s) loaded.`
            : "Ready";
          rerender();
          break;
        }
        case "clearReferences":
          state.referenceImages = [];
          state.status = "Reference images cleared.";
          rerender();
          break;
        case "selectImage":
          state.selectedImageIndex = clampIndex(Number(data.index ?? 0), state.images.length);
          state.currentMediaKind = "image";
          state.status = getSelectedImage(state)
            ? `Selected image ${state.selectedImageIndex + 1}.`
            : state.status;
          rerender();
          break;
        case "selectVideo":
          state.selectedVideoIndex = clampIndex(Number(data.index ?? 0), state.videos.length);
          state.currentMediaKind = "video";
          state.status = getSelectedVideo(state)
            ? `Selected video ${state.selectedVideoIndex + 1}.`
            : state.status;
          rerender();
          break;
        case "generateImage":
          state.busyPreview = getSelectedImage(state)
            ? {
                kind: "image",
                previewSrc: getSelectedImage(state)!.previewSrc,
              }
            : undefined;
          await run(
            state.referenceImages.length
              ? "Remixing image from references..."
              : "Generating image...",
            handleGenerateImage,
          );
          break;
        case "editImage":
          state.busyPreview = getSelectedImage(state)
            ? {
                kind: "image",
                previewSrc: getSelectedImage(state)!.previewSrc,
              }
            : undefined;
          await run("Editing selected image...", handleEditImage);
          break;
        case "generateVideo":
          state.busyPreview = getSelectedImage(state)
            ? {
                kind: "image",
                previewSrc: getSelectedImage(state)!.previewSrc,
              }
            : getSelectedVideo(state)
              ? {
                  kind: "video",
                  previewSrc: getSelectedVideo(state)!.previewSrc,
                  aspectRatio: getSelectedVideo(state)!.aspectRatio,
                }
              : undefined;
          await run("Generating video...", handleGenerateVideo);
          break;
        case "editVideo":
          state.busyPreview = getSelectedVideo(state)
            ? {
                kind: "video",
                previewSrc: getSelectedVideo(state)!.previewSrc,
                aspectRatio: getSelectedVideo(state)!.aspectRatio,
              }
            : undefined;
          await run("Editing selected video...", handleEditVideo);
          break;
        case "extendVideo":
          state.busyPreview = getSelectedVideo(state)
            ? {
                kind: "video",
                previewSrc: getSelectedVideo(state)!.previewSrc,
                aspectRatio: getSelectedVideo(state)!.aspectRatio,
              }
            : undefined;
          await run("Extending selected video...", handleExtendVideo);
          break;
        default:
          break;
      }
    })();
  });

  win.on("closed", () => {
    STUDIO_WINDOWS.delete(win);
  });
}
