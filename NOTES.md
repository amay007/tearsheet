# TearSheet — Technical Notes (last updated 2026-07-27)

Single-page Next.js 16 (App Router, TypeScript, Tailwind v4) app that turns a
company name or URL into an evidence-cited "teardown" via Gemini + Google
Search grounding. Live at https://tearsheet-iota.vercel.app.

## Architecture

- `src/app/page.tsx` — UI and client state machine: `idle → resolving →
  choices → loading`. Classifies input, calls `/api/resolve` for name
  inputs then `/api/teardown` (forwarding the resolved `companyName`/
  `companyDescriptor`, not just the domain — see Identity anchoring
  below); renders the confirmation strip, option cards, mode pills, and
  the final teardown. Double-submit guarded via a ref, not just
  `disabled` state.
  - Reads `?q=` / `?mode=` from the page's `searchParams` prop via
    React's `use()` (not `useEffect` + `window.location` — that pattern
    trips the `react-hooks/set-state-in-effect` lint rule and, more
    importantly, causes an SSR/CSR hydration mismatch on the input's
    controlled value). This makes `/` a dynamically-rendered route.
    Prefills the input/mode but never auto-submits.
  - Teardown text is split into `verdict` / `body` (via `extractStats`
    then `splitVerdict`), then `body` is split into sections on `## `
    headings (`parseSections`). Each section renders through its own
    `<ReactMarkdown>` instance with a `components` override chosen by
    section title: card-list rendering (`cardComponents`) for the 3
    Questions section and any mode's 6th section, left-border accent
    rendering (`fragilityComponents`) for Fragilities, plain default for
    the rest. Falls back to rendering the whole `body` unsplit if no
    `## ` headings are found (malformed model output).
  - `extractStats()` parses a trailing `STATS: Founded=... | Funding=...
    | Headcount=... | HQ=...` (or `STATS: none`) line off the end of the
    response and strips it from the displayed body. Stat strip only
    renders when ≥2 fields are confidently known (dash-valued fields are
    never fabricated or displayed).
  - Copy-as-Markdown reconstructs Verdict + body + a `## Sources` list
    from the `sources` array and copies via Clipboard API. Copy Link
    builds a `?q=<companyName-or-url>&mode=<mode>` URL from the same
    origin/pathname.
- `src/app/api/teardown/route.ts` — model `gemini-2.5-flash` via
  `@google/genai` v2.13.0 on Vertex AI / Gemini Enterprise Agent Platform,
  `tools: [{ googleSearch: {} }]`. System prompt enforces: a
  `Verdict: [one sentence]` opening line (no title heading, no hedging),
  5 fixed sections, inline citations, banned filler, explicit flagging of
  conflicting numbers (Growjo/Prospeo/Owler-style aggregators treated as
  low-confidence), business-model-not-product analysis in Section 1,
  Fragilities required as a bulleted list (needed so the CSS accent has
  list items to attach to), exactly 3 sharp questions in Section 5,
  anomaly interrogation instead of side-by-side listing, at most one
  bolded figure per section, and a trailing `STATS:` line. Citations
  from `groundingMetadata.groundingChunks[].web.{uri,title}`.
  - **Use-case modes** — `mode` param (`general` default, `investing`,
    `interviewing`, `selling`, `competing`). Non-general modes append one
    `MODE_SECTION_PROMPTS[mode]` block to the base system prompt, adding
    exactly one "## 6. ..." section (Diligence Notes / 5 Sharp Questions
    to Ask Their Leadership / Sales Intelligence / Competitive Playbook)
    without altering Sections 1–5 or the Verdict line. Logged in
    `TEARDOWN_OK`/`FAIL`.
  - **Identity anchoring** — the route accepts optional `companyName`/
    `companyDescriptor` in the request body (forwarded by the frontend
    from the resolve step). When present and distinct from the bare
    domain, the user message gets an explicit clause naming the domain
    as ground truth for company identity and warning that even a
    same-name, same-country, same-industry company is not automatically
    the same company as the one at that domain — facts must tie back to
    the domain, not just a name/topic match. Mirrored as a system-prompt
    hard requirement for the direct-URL-input path (no separate resolve
    step, so no companyName to forward). Exists because the teardown
    call's own open-ended `googleSearch` grounding has nothing else to
    anchor to besides the domain string, and can otherwise drift to an
    unrelated company that merely shares a name.
- `src/app/api/resolve/route.ts` — cheap grounded lookup for name inputs.
  Same model, `maxOutputTokens: 2048`, `thinkingConfig.thinkingBudget:
  1024` (bumped from 256 — the disambiguation logic below needs more
  room to actually execute a two-step check, not just pattern-match).
  Returns a strict JSON array of `{name, oneLineDescriptor, domain,
  confidence}` — one entry when only one company clears the bar below,
  2–3 when genuinely ambiguous, `[]` when nothing matches. System prompt
  is an explicit process: (1) find the best match, (2) check for a
  second real company anywhere in the world under essentially the same
  name, (3) only count it as ambiguity if its brand name is essentially
  identical (not just a shared word inside a longer, different business
  name) AND it's independently notable (funding/press/real users, not a
  tiny local business) AND a reasonable person could plausibly have
  meant either — critically, evaluated on each candidate's own
  legitimacy, not its size relative to the other candidate. Parser
  tolerates prose or code-fences around the array instead of requiring
  an exact match, and drops entries with a malformed or non-domain-shaped
  `domain`. Parse failures and true no-matches both show the same
  friendly "couldn't find" message to the user, while staying
  distinguishable server-side (`RESOLVE_OK`/`RESOLVE_AMBIGUOUS`/
  `RESOLVE_FAIL`).
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
- `src/app/globals.css` — `.card-list`/`.card-list-ordered`/
  `.card-list-item`/`.fragility-item` selectors are all prefixed with
  `.teardown` specifically so they out-specificity `.teardown ol`/
  `.teardown ul` (see Known issues: this was the double-numbering bug).
  Ordered-card numbering is pure CSS (`counter-reset`/`counter-increment`
  + `::before`), not derived from list position in JS.
- `src/app/layout.tsx` — `metadataBase` + explicit `openGraph`/`twitter`
  metadata (title/description/image) so shared links unfurl with real
  content instead of Next.js defaults.
- `src/app/opengraph-image.tsx`, `src/app/icon.tsx` — code-generated via
  `next/og`'s `ImageResponse` (1200×630 branded OG image, 32×32 favicon),
  not static image files.

## Shipped and verified

- **Core teardown flow** — validated across many live runs, including
  company-name-collision cases correctly disambiguated. `npx tsc
  --noEmit` / `npx eslint .` clean.
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
- **Use-case mode pills** (2026-07-27) — General/Investing/Interviewing
  there/Selling to them/Competing with them, mobile-safe (flex-wrap) row
  below the input. Verified General mode leaves Sections 1–5 and Verdict
  byte-for-byte structurally unchanged; verified Interviewing mode adds
  exactly one correctly-formatted 6th section. Switching pills after a
  result is shown clears the stale result without auto-regenerating.
- **Visual pass** (2026-07-27) — bordered cards for Section 5 and any
  mode's 6th section, left-border accent on Fragilities, at most one
  bolded figure per section (model-side rule, tightened after an early
  version let it bold several), compact Founded/Funding/Headcount/HQ
  stat strip below the Verdict (skipped when <2 fields are confidently
  known, dash-filled otherwise, never fabricated).
- **Copy/share/favicon/OG** (2026-07-27) — Copy as Markdown, Copy Link
  (`?q=&mode=` prefill deep link), code-generated favicon and OG image,
  explicit `openGraph`/`twitter` metadata. Verified production build
  succeeds, OG image/favicon both resolve as valid PNGs, deep-link
  prefill populates the input and mode pill correctly.
- **Mobile check at ~390-400px** (2026-07-27) — mode pills, cards,
  Fragilities accent, stat strip, copy/share buttons, and the full
  teardown render checked in Chrome dev tools. One issue found and
  fixed: the stat strip's flex-row tiles could refuse to wrap a long
  value (e.g. a full "City, State, Country" HQ string), forcing
  horizontal overflow — fixed with `min-w-0`/`break-words` on each
  tile. Everything else (pill wrapping, card borders, numbering,
  accent, button sizing) confirmed clean with no further changes
  needed.
- **Analytics** — Vercel Analytics on the root layout; `TEARDOWN_OK`/
  `TEARDOWN_FAIL` structured logging grep-able in Vercel function logs.
- **Deployed** on Vercel Hobby plan; live runs confirmed no function
  timeout.

## Bugs found and fixed (2026-07-27, same evening as the visual pass)

- **Sources silently went missing.** The trailing `STATS: ...` line
  instruction added during the visual pass — originally framed as "the
  absolute last line of your entire output, nothing follows it, no
  markdown formatting" — caused `gemini-2.5-flash` to skip the
  `googleSearch` tool entirely on some calls (0 grounding chunks, 0 web
  search queries, shorter/faster responses reading as generated from
  parametric memory). Isolated via a direct A/B script against the
  Gemini API bypassing the Next.js route: the pre-existing prompt
  reliably grounded (28–31 chunks) on the same domain; the STATS block
  in isolation reproduced 0 chunks/0 queries. Fixed by rewording it as a
  normal trailing bullet folded into the existing hard-requirements list
  instead of a separate, highly prescriptive "final line" contract.
  Verified restored (22+ real sources) through the actual app afterward.
- **Resolve prompt was over-suppressing genuine ambiguity, then
  over-correcting.** The old prompt gated multi-candidate results on the
  two companies being of "comparable size or prominence" to *each
  other*, letting a big company's fame silently suppress a smaller but
  still real, notable company sharing its name (`snabbit` non-
  deterministically returning only one of two real, unrelated
  companies). First fix (evaluate each candidate's legitimacy
  independently, drop the "comparable to the other" gate) over-
  corrected: `stripe` briefly started returning unrelated small
  businesses ("Stripes Design", "Stripe Design Services") that merely
  share a word, not the same name. Final version requires an *
  essentially identical* brand name (not a substring/loose match) *and*
  independent notability before counting as ambiguity. Verified: `clay`
  and `wave` correctly return their real distinct namesakes; `stripe`
  and `zetwerk` correctly stay single-match. `snabbit` itself remains
  the hardest case — see Known issues.
- **Teardown could analyze the wrong company entirely.** The frontend
  resolved companies correctly but only ever forwarded the bare domain
  to `/api/teardown`, discarding the verified name/descriptor. The
  teardown call's own independent `googleSearch` grounding, given only a
  domain string, could drift to a different company that merely shares
  a name (reproduced case: a `snabbit.com` teardown coming back about a
  Swedish cloud-infrastructure company instead of the Indian
  home-services one). Fixed via the Identity anchoring mechanism
  described in Architecture above. Verified across 6 real teardown runs
  on `snabbit.com`: zero mentions of the wrong company in any run.
- **Double-numbering on ordered card lists.** `.card-list`/
  `.card-list-ordered`/`.fragility-item` (CSS specificity 0,1,0) were
  losing to `.teardown ol`/`.teardown ul` (specificity 0,1,1), so the
  browser's native decimal/disc marker rendered underneath the custom
  counter badge and accent border on every ordered-list card. Fixed by
  prefixing the card/fragility selectors with `.teardown` so they win on
  specificity regardless of source order.

## Deferred

Not implemented: rating widget, confidence footer, run-diffing.

## Known issues / soft edges

- **Google Search grounding is non-deterministic per call**, independent
  of prompt wording — the same exact prompt against the same domain has
  returned anywhere from 0 to 31 grounding chunks across repeated calls
  during testing. The STATS-line fix above removed one *systematic*
  cause of 0-source responses; ordinary call-to-call variance in
  whether the model chooses to search remains and isn't something a
  prompt can fully eliminate. Confirmed 2026-07-28 this reproduces on
  the **live production URL**, not just localhost: 3 consecutive calls
  to `https://tearsheet-iota.vercel.app/api/teardown` with the same
  domain returned 0, then 12, then 16 real grounding sources. Checked
  for a prod-specific cause (env vars, region, auth path) and found
  none — `src/lib/gemini.ts` reads the same `GOOGLE_CLOUD_PROJECT`/
  `GOOGLE_CLOUD_LOCATION` env vars in both environments, no
  `NODE_ENV`/`VERCEL`-conditional branching anywhere in the app, and
  auth clearly works in prod (all 3 calls returned valid, correctly-
  identified text — a broken credential would fail the whole call, not
  just zero out sources). This is model/search variance, not a
  deployment bug. Mitigated (not eliminated) by a system-prompt rule:
  sections with little independent sourcing must say so explicitly and
  signal extra caution, instead of reading with the same confident tone
  as a well-sourced section.
- **Same company name colliding *within the same country* is only
  partially handled.** Domain-anchoring (above) reliably prevents
  cross-country/cross-industry mixups (confirmed fix: Swedish vs
  Indian "Snab(b)it"). But testing on `snabbit.com` surfaced what
  appears to be two distinct real Indian companies both named
  "Snabbit" (a small one, founded ~2017, no funding data; a VC-backed
  one, founded 2024, $56M raised per TechCrunch) — the anchor reduces
  but doesn't fully eliminate the model conflating these two, and a
  couple of test runs produced a thin/uncertain "no data found" answer
  instead of the funded company's real numbers. Likely intertwined with
  the grounding non-determinism above rather than a distinct root cause.
- `/api/resolve` occasionally returns empty model output (finishReason
  `STOP`, zero candidate tokens) on hard/garbled name inputs — reproduced
  consistently for one gibberish string during testing. Root cause not
  isolated. Masked by treating parse/empty-output failures the same as a
  clean no-match, which is correct user-facing behavior either way — but
  some resolvable names may silently show as not-found. Revisit if
  `RESOLVE_FAIL ... category=parse_error` shows up at real frequency in
  production logs.
- In-memory rate limiting is per-instance — move to Redis/Upstash if
  traffic scales across multiple serverless instances.
- No source-quality rule yet for well-covered public companies — the
  aggregator low-confidence rule was written with smaller/private
  companies in mind.
- No headless-browser/screenshot tooling in this environment — UI
  changes are verified via `tsc`/`eslint`, curl against the API routes,
  static DOM-structure checks (`react-dom/server` render of the actual
  components against real API output), CSS specificity analysis where
  applicable, and manual in-browser checks done separately (mobile
  check at ~390-400px was done this way, in Chrome dev tools).

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
