# TearSheet — Build Notes (last updated 2026-07-26)

## What was built

Single-page Next.js 16 (App Router, TypeScript, Tailwind v4) app.

- `src/app/page.tsx` — URL input, Generate button (double-submit guarded via a
  ref, not just `disabled` state), animated loading state, rendered markdown
  result with a Sources list.
- `src/app/api/teardown/route.ts` — calls Gemini via `@google/genai` (v2.13.0)
  on Vertex AI / Gemini Enterprise Agent Platform, Google Search grounding on.
- `src/lib/companyUrl.ts` — shared input normalization/validation (client + server).
- `src/lib/rateLimit.ts` — in-memory per-IP rate limiter.
- System prompt enforces 5 sections, inline citations, banned filler, flags
  conflicting numbers (low-confidence tag for Growjo/Prospeo/Owler-style
  aggregators), forces business-model analysis in Section 1, bans generic
  fragilities, requires single sharp questions in Section 5, and forces
  anomaly interrogation rather than side-by-side fact-listing.
- Response text is assembled by explicitly filtering `part.thought` parts, so
  no leaked model reasoning can reach the screen.

Grounding config: `config: { tools: [{ googleSearch: {} }] }`; citations come
from `response.candidates[0].groundingMetadata.groundingChunks[].web.{uri,title}`.

Verified clean: `npx tsc --noEmit` and `npx eslint .`.

## Vertex AI / Gemini Enterprise Agent Platform migration

- Project: `tearsheet-503518`. Region: `us-central1`.
- Auth: `googleAuthOptions.credentials` parsed from `GOOGLE_CREDENTIALS_JSON`
  env var when present (serverless/Vercel), falling back to the local
  `gcp-credentials.json` key file (gitignored) for local dev. SDK config:
  `enterprise: true` (`vertexai: true` still works but is deprecated
  post-rebrand in SDK 2.13.0). Both paths verified locally 2026-07-26.
- Model: `gemini-2.5-flash` (works immediately). `gemini-flash-latest` doesn't
  exist on this platform (Developer-API-only alias). `gemini-3.6-flash` is
  cataloged but access-gated for fresh trial projects — request via Model
  Garden later if wanted.
- Free trial credits: $300, ~90 days, expires ~late October 2026 — reassess
  at day 75.

## Launch readiness (2026-07-26) — complete and verified

- Input validation: trims, accepts bare domains and full URLs, rejects
  empty/non-domain/>200-char input with friendly inline errors.
- Rate limiting: 5 requests/IP/hour, in-memory, keyed off `x-forwarded-for`;
  429 + `Retry-After` with a plain "you've hit the limit" message.
- Error sanitization: every visitor-facing error is a specific friendly
  validation message or one fixed generic string — no raw JSON, upstream
  error text, or stack traces ever reach the client. Oversized bodies
  (>10KB) rejected before parsing.
- Secrets audit: `.env.local` and `gcp-credentials.json` both gitignored; no
  git repo exists yet so no history to check; no hardcoded keys in source.
- Hygiene: scratch script removed, `.claude/settings.local.json` gitignored,
  README rewritten (was untouched create-next-app boilerplate).
- MIT license: pending, not yet added.

## Next: deploy sequence

1. `git init`, then re-verify secrets are excluded (`git status`, `git
   check-ignore`) before the first commit.
2. Push to GitHub.
3. Convert `gcp-credentials.json` into an env var; switch
   `googleAuthOptions.keyFile` → `googleAuthOptions.credentials` in
   `src/app/api/teardown/route.ts`.
4. Import into Vercel with three env vars (`GOOGLE_CLOUD_PROJECT`,
   `GOOGLE_CLOUD_LOCATION`, the new credentials var).
5. Measure real teardown latency against the Hobby plan's function timeout —
   flagged as a risk earlier, not yet tested live.

## Known post-launch items

- In-memory rate limit is per-instance — move to Redis/Upstash if traffic
  scales across multiple serverless instances.
- If Hobby-plan timeouts bite, streaming the response is the free fix.
- Prompt still occasionally prepends a stray title line before Section 1.
- No source-quality rule yet for well-covered public companies — the
  aggregator low-confidence rule was written with smaller/private companies
  in mind.
