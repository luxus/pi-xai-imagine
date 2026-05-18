# Changelog

All notable changes to this project will be documented in this file.

## 0.5.0: Grok Build OAuth Integration

### Changed

- `pi-xai-imagine` now prefers Grok Build / Coding Plan OAuth credentials from the main `pi-xai` extension (after running `/login grok-build`).
- Credential resolution in execution paths (generate/edit image, generate/edit/extend video, understand_image, health checks, studio open) now delegates to the async `getRequiredXaiApiKey()` resolver. When the main `pi-xai` package is present this uses its `getEffectiveXaiApiKey` (JWT refresh + `~/.grok/auth.json` fallback). Falls back cleanly to local `XAI_API_KEY` / Pi settings when the main resolver is unavailable.
- All imagine API calls continue to go exclusively through the shared `XaiClient` (which always sends `Authorization: Bearer <key>`). The preferred token from the OAuth resolver now reaches every xAI image / video / vision endpoint.

### Added

- Explicit async/sync split for credential helpers (`getRequiredXaiApiKey` async for execution, `getRequiredXaiApiKeySync` for registration surfaces).
- The resolver is loaded via dynamic `import("pi-xai")` (no hard dependency; `pi-xai` lives in `optionalDependencies`).
- Error messages now recommend `/login grok-build` as the preferred path.
- `CHANGELOG.md` introduced with this release.

This release aligns `pi-xai-imagine` with the Grok Build authentication story already present in `pi-xai` and `pi-xai-voice`, so users only need to authenticate once via the main extension.

## 0.1.0: Initial public release

- First standalone release of the Pi xAI Imagine extension (image, video, vision tools + Glimpse studio integration).
