# OrionTV x MoonTV Live Integration Plan

## Scope and Principles

- Use MoonTV live APIs as the only live data source.
- Remove dependency on manual `m3uUrl` input.
- Reuse existing UI/components/stores as much as possible.
- Keep build count low by validating with static checks first.
- Ship in small milestones to reduce regression risk.

## Build-Minimization Strategy

1. Do local static checks first for every code change:
   - `yarn lint`
   - `yarn typecheck`
2. Only run APK build at milestone boundaries.
3. Prefer GitHub Actions release build for final APK artifact.
4. Target build budget:
   - Milestone 1: 0-1 APK build
   - Milestone 2: 0-1 APK build
   - Milestone 3: 1 APK build
   - Total target: 2-3 APK builds for full feature delivery

## Reuse-First Architecture

- Keep current `apiBaseUrl` and auth flow; add new live API methods in `services/api.ts`.
- Keep current `LiveScreen` layout and modal pattern; replace data source only.
- Keep current grouped channel UI behavior (`group -> channels`) and focus logic.
- Keep current `StyledButton`, `ResponsiveNavigation`, `ResponsiveHeader`.
- Reuse existing storage manager pattern in `services/storage.ts` for live favorites.
- Keep existing settings page shell; hide/remove only the `LiveStreamSection` input path.

## Milestone Plan

### Milestone 1: API Wiring (No UX Expansion)

Goal: make live page read from MoonTV APIs instead of M3U URL.

Tasks:

- Add API methods:
  - `getLiveSources()` -> `GET /api/live/sources`
  - `getLiveChannels(source)` -> `GET /api/live/channels?source=...`
  - `getLiveEpg(source, tvgId)` -> `GET /api/live/epg?source=...&tvgId=...`
- Update `app/live.tsx` load flow:
  - load sources
  - pick default source
  - load channels for selected source
- Keep current group/channel modal and channel switching behavior.
- Remove direct use of `fetchAndParseM3u` in live page.

Validation:

- Local: lint + typecheck.
- Optional single APK build only if static checks pass and logic compiles cleanly.

### Milestone 2: Source Navigation + Performance Guardrails

Goal: improve usability without rewriting core UI.

Tasks:

- Add source-level selector in live page (source -> group -> channel).
- Add in-memory cache per source to avoid refetching channel lists repeatedly.
- Keep channel list rendering with existing `FlatList` and focused-item behavior.
- Add lightweight loading/error states using existing visual patterns.

Validation:

- Local: lint + typecheck.
- One APK build only if source switching and focus navigation are stable.

### Milestone 3: Live Favorites (TV Channel Favorites)

Goal: add favorites for live channels with minimal new UI.

Tasks:

- Add `LiveFavoriteManager` in `services/storage.ts` (local AsyncStorage only).
- Favorite key format: `source+tvgId` (fallback `source+channelId`).
- Add favorite toggle in live channel list item.
- Add a "Favorites" pseudo-group at top of live channel groups (reuse existing group list).
- Keep movie/series favorites untouched to avoid cross-feature regression.

Validation:

- Local: lint + typecheck + targeted manual flow test.
- Final GitHub Actions APK build.

## Risk Control

- Do not refactor unrelated screens.
- Do not replace navigation architecture.
- Do not change auth model unless live API auth fails in real tests.
- Keep backward compatibility in settings storage (ignore old `m3uUrl`, do not break existing users).

## Delivery Checklist

- [ ] Live page no longer depends on manual `m3uUrl`.
- [ ] Source -> group -> channel navigation works with TV remote focus.
- [ ] Live favorites can be add/remove and persist after app restart.
- [ ] Final APK built via GitHub Actions and installable on target TV.
- [ ] Existing VOD search/detail/play/favorites features still work.
