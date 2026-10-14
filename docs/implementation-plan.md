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

## Mobile and edge-case follow-up (2026-10-14)
- Rechecked all 103 automated tests: passing. Coverage includes permission and network errors, duplicate speech results, stale session responses, cancellation races, missing credentials, expired gateway tokens, malformed provider responses and concurrent budget reservations.
- Browser responsive matrix: 320×568, 360×800, 375×667, 390×844, 430×932, 768×1024 and 844×390; 76 states across settings, gateway form, background profile, captions, answers, long text, manual entry, usage disclosure, help, ended sessions and live controls. Microphone events were simulated; no paid calls.
- Fixed measured 34–40px controls by making touch targets at least 44×44 CSS pixels. Increased essential secondary text and Chinese captions, added an accessible help-button name and wrapping for long prior questions.
- Mobile session controls remain reachable while reading; detailed token usage is available through the “用量” disclosure. Short landscape uses one panel at a time and a compact action row. Reduced heading space keeps tabs and some caption content visible above the controls.
- Caption auto-follow and “回到最新” now scroll the transcript container only. Browser checks confirm new captions and button activation do not move the outer page; reduced-motion preference is respected.
- Matrix acceptance: no horizontal overflow, no enabled touch controls below 44×44 CSS pixels, tabs unobscured on entry, initial caption area present, pause/resume/end usable, and no uncaught application errors. Desktop/demo/export/API-mock smoke also passed.
- Limits: viewport/touch emulation is not physical iOS/Android testing. Native mobile text selection, the actual software keyboard, Bluetooth microphone changes, background/sleep recovery, real model downloads, provider billing and continuous 60-minute audio quality still need device/account validation.

## Native mobile input and duration follow-up (2026-10-14)
- User target: desktop Chrome primary, phone backup. User explicitly authorized the connected Android phone and USB debugging.
- Fixed native selection handling: document `selectionchange` captures both endpoints within the transcript; saved questions survive a collapsed range and opening the answer tab. Selected-row borders and spacing no longer shift the text-selection handles.
- Fixed focused manual-entry layout: mobile controls return to normal document flow, the form can pan above the software keyboard, and an explicit “收起” action dismisses it.
- Physical Samsung SM-N981B with Chrome Android 155: actual software keyboard appeared; Android key taps entered English; mixed text submitted with both action buttons visible above the keyboard; submitting and collapsing dismissed it. Native Android long-press selected “How”; dragging its handle expanded the range to “How do you manage a project”; both ranges reached the app and the final selection persisted into the answer panel. No JavaScript-created selection was used in this physical-device check. Chinese IME composition was not exercised.
- Added six accelerated long-session tests, including 684 final / 1,368 interim speech observations, reconnects, pauses, translation retries, replacement sessions and delayed timers. Found six reconnects could display 3,594 rather than 3,600 seconds; replaced callback-count timing with monotonic elapsed time, preserving fractional pause intervals.
- Fresh verification: 117 tests passed, production build passed, independent scoped code review found no actionable issue, desktop/mobile mocked-service smoke passed, and native-selection/reduced-viewport regression checks passed. These checks make no paid API calls.
- Responsive regression matrix rerun: all 76 states across seven viewport sizes passed, with no horizontal overflow, undersized touch controls or JavaScript errors.
- Real-time native recognition soak started at 2026-10-14 19:35:49 UTC+8, expected completion after 20:35:49. Status is pending. Immutable production assets: `index-Dhcg7i-2.js` and `index-FTar5Ds_.css`. The harness injects only a synthetic audio track into native Chrome SpeechRecognition; result/error/end events and production caption handlers remain genuine. It checks advancing rendered captions, response time, recognition gaps, heap usage and stop behavior. This does not test physical microphone capture. An earlier short run was interrupted and is excluded from duration evidence.
