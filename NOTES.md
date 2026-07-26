# TearSheet — Technical Notes (last updated 2026-07-26)

Single-page Next.js 16 (App Router, TypeScript, Tailwind v4) app that turns a
company name or URL into an evidence-cited "teardown" via Gemini + Google
Search grounding. Live at https://tearsheet-iota.vercel.app.

## Architecture

- `src/app/page.tsx` — UI and client state machine: `idle → resolving →
  choices → loading`. Classifies input, calls `/api/resolve` for name
  inputs then `/api/teardown`; renders the confirmation strip, option
  cards, and the final markdown (Verdict line split out for distinct
  styling). Double-submit guarded via a ref, not just `disabled` state.
- `src/app/api/teardown/route.ts` — model `gemini-2.5-flash` via
  `@google/genai` v2.13.0 on Vertex AI / Gemini Enterprise Agent Platform,
  `tools: [{ googleSearch: {} }]`. System prompt enforces: a
  `Verdict: [one sentence]` opening line (no title heading, no hedging),
  5 fixed sections, inline citations, banned filler, explicit flagging of
  conflicting numbers (Growjo/Prospeo/Owler-style aggregators treated as
  low-confidence), business-model-not-product analysis in Section 1,
  specific-not-generic fragilities in Section 4, exactly 3 sharp questions
  in Section 5, anomaly interrogation instead of side-by-side listing.
  Citations from `groundingMetadata.groundingChunks[].web.{uri,title}`.
- `src/app/api/resolve/route.ts` — cheap grounded lookup for name inputs.
  Same model, `maxOutputTokens: 2048`, `thinkingConfig.thinkingBudget: 256`.
  Returns a strict JSON array of `{name, oneLineDescriptor, domain,
  confidence}` — one entry when a company is clearly dominant, 2–3 when
  genuinely ambiguous, `[]` when nothing matches. Parser tolerates prose or
  code-fences around the array instead of requiring an exact match, and
  drops entries with a malformed or non-domain-shaped `domain`. Parse
  failures and true no-matches both show the same friendly "couldn't find"
  message to the user, while staying distinguishable server-side
  (`RESOLVE_OK`/`RESOLVE_AMBIGUOUS`/`RESOLVE_FAIL`).
- `src/lib/companyUrl.ts` — `classifyCompanyInput()`: URL only if the input
  is domain-shaped (dot, no spaces, plausible TLD, parses as a hostname);
  otherwise a name. Also `normalizeCompanyUrl()`, `validateInput()`. Return
  types use literal-discriminant unions (`kind: "url"|"name"|"error"`,
  `ok: true|false`) rather than `field?: undefined` unions — the latter
  doesn't reliably narrow under `strict` TypeScript through destructuring.
- `src/lib/gemini.ts` — shared `createGenAIClient()` and
  `categorizeGeminiError()`/`extractResponseText()`, used by both routes.
- `src/lib/rateLimit.ts` — in-memory per-IP limiters keyed off
  `x-forwarded-for`. Teardown: 5/hour. Resolve: 20/hour on a separate
  limiter, so browsing disambiguation options never eats the teardown
  budget.
- Response assembly filters `part.thought` in both routes, so no leaked
  model reasoning reaches the screen.

## Shipped and verified

- **Core teardown flow** — validated across 10+ live runs, including a
  company-name-collision case correctly disambiguated. `npx tsc --noEmit`
  / `npx eslint .` clean.
- **Verdict line** (2026-07-26) — verified live: no title heading leaked,
  no banned hedge words, rendered distinctly (`.verdict-line`, 1.35rem/700)
  instead of passing through ReactMarkdown.
- **Company name or URL input, with disambiguation** (2026-07-26) —
  verified locally and in-browser: `zetwerk` (single clean match), `cube`
  (ambiguous, 3 real candidates), `zetwrek` (typo resolved), `gocomet.com`
  (URL bypasses resolution, unchanged), gibberish input (graceful
  no-match). Fixed during build: `thinkingConfig.thinkingBudget` was
  interacting with the `googleSearch` tool, causing repeated/looping
  output truncated mid-JSON — fixed by tuning the budget/token cap and
  making the JSON parser tolerant of prose/fences around the array.
- **Analytics** — Vercel Analytics on the root layout; `TEARDOWN_OK`/
  `TEARDOWN_FAIL` structured logging grep-able in Vercel function logs.
- **Deployed** on Vercel Hobby plan; live runs confirmed no function
  timeout.

## Deferred

Not implemented: use-case modes, interview mode, rating widget, confidence
footer, run-diffing.

## Known issues / soft edges

- `/api/resolve` occasionally returns empty model output (finishReason
  `STOP`, zero candidate tokens) on hard/garbled name inputs — reproduced
  consistently for one gibberish string during testing. Root cause not
  isolated (thinking-budget/search-tool interaction is the leading
  suspect). Masked by treating parse/empty-output failures the same as a
  clean no-match, which is correct user-facing behavior either way — but
  some resolvable names may silently show as not-found. Revisit if
  `RESOLVE_FAIL ... category=parse_error` shows up at real frequency in
  production logs.
- In-memory rate limiting is per-instance — move to Redis/Upstash if
  traffic scales across multiple serverless instances.
- No source-quality rule yet for well-covered public companies — the
  aggregator low-confidence rule was written with smaller/private
  companies in mind.
- No automated browser test coverage in this environment — UI changes are
  verified via `tsc`/`eslint`, curl against the API routes, and manual
  in-browser checks.

## Running and deploying

- Local dev: `npm run dev`. Requires either `GOOGLE_CREDENTIALS_JSON`
  (JSON service-account key as a string, used in production) or a local
  `gcp-credentials.json` key file (gitignored) at the project root, plus
  `GOOGLE_CLOUD_PROJECT` and optionally `GOOGLE_CLOUD_LOCATION` (defaults
  to `us-central1`) in `.env.local`.
- Checks: `npx tsc --noEmit`, `npx eslint .`. Build/run: `npm run build`,
  `npm run start`.
- Deployed on Vercel (Hobby plan) with env vars `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CREDENTIALS_JSON`.
- GCP project `tearsheet-503518`, region `us-central1`, model
  `gemini-2.5-flash` (`gemini-flash-latest` doesn't exist on this
  platform; `gemini-3.6-flash` is cataloged but access-gated for fresh
  trial projects). $300 trial credit expires ~late Oct 2026.
