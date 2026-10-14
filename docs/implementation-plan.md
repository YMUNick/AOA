# AOA implementation plan

**Goal:** Ship the approved interview assistant to GitHub Pages, with real microphone captions, Traditional Chinese translation, explicit selected-text AI answers, and visible usage estimates.
**Architecture:** Static React/TypeScript frontend, browser speech/translation adapters, bounded AI client, and optional authenticated Cloudflare Worker with durable budget accounting.
**Spec:** `docs/design/2026-10-14-aoa-design.md` and approved dark mockups.
**Authorization:** User approved design and explicitly requested engineering and deployment on 2026-10-14. Proceed in this chat with parallel contributors and final review.

## Constraints
- Desktop Chrome primary; microphone only, English to Traditional Chinese.
- Real captions and explicit mock/demo mode must never be confused.
- No provider keys in source, build, URL, persisted browser storage, or logs.
- Paid cloud translation must be explicitly selected. Answer generation only follows a user action.
- Graceful manual-text fallback. Cancel/stop and retries must not resurrect ended sessions.
- GitHub Pages base `/AOA/`; preview and demo work without credentials.
- Cloudflare deployment requires an available account; Pages deployment is independently deliverable. Ship a working personal BYOK option with memory-only credentials when a gateway is not configured.

## Tasks and interfaces

1. **App foundation and UI (root)**: package/config, `src/types.ts`, `src/App.tsx`, `src/styles.css`, components. Consume browser controller and API client interfaces below. Match approved two-panel dark UI, settings, demo, manual text, selection snapshot, copy/export, status, budget, mobile tabs.
2. **Browser adapters (agent)**: `src/lib/speech.ts`, `translator.ts`, `budget.ts` and matching tests. Export `SpeechController({onInterim,onFinal,onState,onError})` with start/pause/stop; stable final IDs. Export `getTranslationAvailability()`, `createLocalTranslator(onProgress?)` returning translate/destroy. Pure `estimateCost`, `estimateHourlyCost`, `BudgetLedger` controls reservations/settlement and unknown usage.
3. **AI client and gateway (agent)**: `src/lib/ai.ts`, `worker/**`, tests. Export `connectGateway(settings,signal?)`, `generateAnswer(settings,{question,context,profile,style},signal?)`, `translateCloud(settings,text,signal?)`; return `{text,usage}`. Support OpenAI and Gemini in personal mode; OpenAI in authenticated gateway. Validate sizes, timeouts, output caps, errors, no prompt logging. Worker durable reservations, duplicate prevention and auth, bounded lifetime tokens, rate limiting.
4. **Deployment and verification (root + reviewer)**: installation, type check, unit tests for lifecycle/errors/budget/API contracts, browser smoke at desktop/mobile with demo and mocked services; secret scan and build verification. Commit/push to supplied repository, enable GitHub Pages, watch successful build and fetch public page. Final independent review before release.

## Test-first critical behavior
- Speech final dedupe, stale events ignored, permission error no retry, stop prevents onend restart.
- Translator availability/download failure and selected local mode never silently uses cloud.
- Budget refuses nonfinite/negative values and concurrent reservations over limit; missing usage retains reservation.
- API error handling, timeout/cancel, input/output bounds, gateway auth and duplicate accounting.
- UI selection snapshot persists during new transcript additions; new session cannot receive previous generation's answer.

## Execution ledger
- Baseline: empty repository (no HEAD), existing design files only. Work in supplied checkout to preserve approved assets; no unrelated work to isolate.
- Plan coverage reviewed: frontend owns shared types; browser and AI tasks own separate modules. Both consume the same explicitly defined Settings/Usage interfaces.
- Provider deployment: personal BYOK is a usable alternative; do not claim the optional Worker is deployed if Cloudflare credentials are unavailable.
- Implemented: approved responsive UI, microphone captions, local translation preparation, explicit cloud translation, selected-text answers, transcript export, manual entry, demo, in-memory credentials, token/cost display and budget reservations.
- Connection recovery: personal credentials can be added during a session without clearing captions or budget; expired gateway sessions refresh once with the original request ID.
- Independent code review: no remaining high/medium issue in the core app, connection recovery, or authenticated cancellation endpoint.
- Browser smoke: desktop and 390px mobile layouts, isolated demo, manual text, export, mocked microphone/local translation, mid-session credential repair, exactly one mocked answer request, and pause/stop passed with no application errors or paid calls.
- Release verification: 103 tests passed; production build and both TypeScript checks passed; real workerd/SQLite smoke passed signed sessions, durable accounting, duplicate prevention and explicit upstream cancellation. All provider responses were mocked; no paid API calls were made.
- Published: application commit `5676ae4a00786ece1fbc8c2d961434e36bed19c8` pushed to `main`; GitHub Actions run [38552387351](https://github.com/YMUNick/AOA/actions/runs/38552387351) completed successfully. Pages uses GitHub Actions as its source.
- Public verification: [https://ymunick.github.io/AOA/](https://ymunick.github.io/AOA/) returned HTTP 200 with correct `/AOA/` assets. The same desktop/mobile browser smoke passed against the public deployment, including mocked microphone, translation and answer generation; no paid calls were made.
- Remaining environment checks: real microphone/provider verification and a continuous 60-minute session. The optional Cloudflare Worker has not been deployed; personal API-key mode is available on the published frontend.
