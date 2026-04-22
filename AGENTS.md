# Agent Guide: pi-xai-imagine

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Project Overview

This is a **Pi extension for xAI media workflows** (image generation, editing, video, vision). It contains both Pi-specific integration code AND a reusable core that can be copied to other xAI-based projects.

## File Structure

```
# Reusable Core (xAI-agnostic, copy-fertig)
xai-client.ts       → XaiClient class (fetch, download, healthcheck)
xai-config.ts       → Config resolution with namespace support (xai.imagine/voice/search)
xai-media-shared.ts → Constants, types, asset helpers
xai-media.ts        → Clean re-exports of all core modules
xai-image.ts        → Image generate/edit workflows
xai-video.ts        → Video generate/edit/extend workflows
xai-understanding.ts → Vision/reasoning API

# Pi-Specific (NOT reusable)
index.ts            → Tool registration, Typebox schemas, Extension API
xai-glimpse.ts      → Pi Glimpse Studio integration
```

## Reuse Pattern

When creating a new xAI extension (e.g., `pi-xai-voice`):

1. Copy these files to new project root:

   ```bash
   cp xai-client.ts xai-config.ts xai-media-shared.ts xai-media.ts \
      xai-image.ts xai-video.ts xai-understanding.ts \
      ~/projects/new-extension/
   ```

2. Import from core in your new code:

   ```typescript
   import { XaiClient, getRequiredXaiApiKey, resolveXaiConfig } from "./xai-media.ts";
   ```

3. Build runtime from config:
   ```typescript
   const config = resolveXaiConfig();
   const { apiKey } = getRequiredXaiApiKey(config);
   const client = new XaiClient({ apiKey, baseUrl: config.xai.baseUrl });
   ```

## Config Namespace

Shared config structure for multi-extension setups:

```json
{
  "xai": {
    "apiKey": "xai-...",
    "baseUrl": "https://api.x.ai/v1",
    "imagine": { "autoOpenGlimpse": true },
    "voice": { "model": "grok-tts" },
    "search": {}
  }
}
```

Config sources (priority order):

1. `XAI_API_KEY` env var
2. `./.pi/settings.json` (project-level)
3. `~/.pi/agent/settings.json` (user-level)

## Key Classes

- `XaiClient` — HTTP client with auth, retry, error parsing
- `resolveXaiConfig()` — Loads merged config from all sources
- `getRequiredXaiApiKey()` — Validates and returns API key with source info

## Adding New Tools

1. Implement in reusable core (if generic) or index.ts (if Pi-specific)
2. Use `XaiClient.fetchJson()` for API calls
3. Use asset helpers from `xai-media-shared.ts` for file handling
4. Register tool in `index.ts` with Typebox schemas
