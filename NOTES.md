# TearSheet — Technical Notes (last updated 2026-07-28)

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
    headings (`parseSections`). `splitVerdict()` also detects and skips
    a duplicated opening verdict sentence, if the model repeats it —
    see Bugs found and fixed. Each section renders through its own
    `<ReactMarkdown>` instance with a `components` override chosen by
    section title: card-list rendering (`cardComponents`) for the 3
    Questions section and any mode's 6th section, left-border accent
    rendering (`fragilityComponents`) for Fragilities, plain default for
    the rest. Falls back to rendering the whole `body` unsplit if no
    `## ` headings are found (malformed model output).
  - `extractStats()` parses a trailing `STATS: Founded=... | Funding=...
    | Headcount=... | HQ=... | Revenue=... | Growth=...` (or `STATS:
    none`) line off the end of the response and strips it from the
    displayed body. Stat strip only renders when ≥2 of the 6 fields are
    confidently known (dash-valued fields are never fabricated or
    displayed).
  - Copy-as-Markdown reconstructs Verdict + body + a `## Sources` list
    from the `sources` array and copies via Clipboard API. Copy Link
    builds a `?q=<companyName-or-url>&mode=<mode>` URL from the same
    origin/pathname.
  - **Streaming (2026-07-28)** — `runTeardown()` reads `/api/teardown`'s
    response body via `res.body.getReader()` + `TextDecoder`, buffering
    partial lines and parsing each complete line as one NDJSON event
    (`{type: "chunk"|"done"|"error", ...}` — see the route entry below).
    `chunk` events accumulate into `streamingText` state, which renders
    live through a plain, unsectioned `<ReactMarkdown>` (verdict + body,
    no card/fragility components, no stat strip) while `phase ===
    "loading"`. Only on the `done` event does the code set the existing
    `result`/`sources` state and flip back to `phase: "idle"` — at which
    point the original fully-sectioned render (cards, Fragilities
    accent, stat strip, Copy/Sources UI) takes over exactly as before.
    This means Copy-as-Markdown, Copy Link, and the Sources list are
    only ever reachable once `result` is set, i.e. only after the
    stream fully completes — enforced by them living inside the
    pre-existing `{result && (...)}` block, which the live-streaming
    block is a sibling of, not a replacement for. An `error` event
    (mid-stream failure) or a stream that ends without ever sending
    `done` both throw and fall into the same catch path as any other
    fetch failure.
  - `extractStats()` was hardened from "STATS must be the literal last
    line" (`/\n(STATS:\s*.*)$/`, anchored to end-of-string) to `text.
    lastIndexOf("\nSTATS:")` — finds the line wherever it is and
    discards it plus everything after. Needed because (a) applying the
    old regex to the live, still-growing `streamingText` would only
    ever match once the model had *finished* emitting the STATS line
    and nothing else followed — true for the final state, but the more
    important reason is (b) the model occasionally appends stray
    content after STATS (observed once: a bare list of citation URLs on
    trailing lines), which broke the old end-anchored regex entirely
    and left the raw `STATS: ...` line visible in the rendered body.
    The new version handles both the common case (STATS truly last) and
    the trailing-junk case identically. See Bugs found and fixed.
- `src/app/api/teardown/route.ts` — model `gemini-2.5-flash` via
  `@google/genai` v2.13.0 on Vertex AI / Gemini Enterprise Agent Platform,
  `tools: [{ googleSearch: {} }]`. System prompt enforces: a
  `Verdict: [one sentence]` opening line (no title heading, no hedging),
  5 fixed sections with plain, unnumbered headings (no "1.", "2." etc.
  prefix — a title like "5 Sharp Questions..." keeps its own number,
  only the artificial section-position prefix is banned), inline
  citations, banned filler, explicit flagging of conflicting numbers
  (Growjo/Prospeo/Owler-style aggregators treated as low-confidence),
  business-model-not-product analysis in How They Make Money, that
  section plus Competitive Position and Traction Signals required to
  open with a short paragraph then 2-4 sub-bullets for discrete facts
  (not one dense paragraph), Fragilities required as a bulleted list
  (needed so the CSS accent has list items to attach to), exactly 3
  sharp questions in the 3-Questions section, anomaly interrogation
  instead of side-by-side listing, at most one bolded figure per
  section, a note of low-confidence/extra-caution for thinly-sourced
  sections, and a trailing 6-field `STATS:` line (Founded/Funding/
  Headcount/HQ/Revenue/Growth). Citations from
  `groundingMetadata.groundingChunks[].web.{uri,title}`.
  - **Streaming (2026-07-28)** — calls `ai.models.generateContentStream()`
    instead of `generateContent()`, returning `Promise<AsyncGenerator
    <GenerateContentResponse>>`. The route wraps a `for await` over that
    generator in a Web `ReadableStream`, and for each yielded chunk:
    reuses `extractResponseText()` unchanged (so thought-part filtering
    is identical to the non-streaming path) and, if it produced text,
    enqueues an NDJSON line `{"type":"chunk","text":"..."}\n`; separately
    accumulates that chunk's `groundingMetadata.groundingChunks` into a
    `Map` keyed by URI (same dedup logic the old single-response path
    used, just fed incrementally instead of all at once — grounding
    metadata isn't guaranteed to land on any particular chunk, so all of
    them are checked). Once the generator is exhausted, sends one final
    `{"type":"done","sources":[...]}\n` line (or `{"type":"error",
    "message":...}\n` if no text was ever produced, or if the generator
    itself threw mid-stream) and closes the stream — `TEARDOWN_OK`/`FAIL`
    logging fires at that point either way, unchanged in content from the
    non-streaming version, just relocated to fire on stream-completion
    instead of on function-return. Response headers: `Content-Type:
    application/x-ndjson`, `Cache-Control: no-cache, no-transform`,
    `X-Accel-Buffering: no` (defensive against proxy buffering); route
    also declares `export const dynamic = "force-dynamic"`.
    Rate limiting, body-size/content validation, and client-creation
    failures are all unchanged and still return a normal
    `NextResponse.json({error}, {status})` before any stream opens —
    only failures *after* streaming has begun (mid-stream Gemini errors)
    can no longer change the HTTP status code, since headers are already
    committed to 200; those are signaled via the `error` NDJSON event
    instead. Also watches accumulated text for a leaked raw tool-call
    payload (`LEAKED_TOOL_OUTPUT_PATTERN`) and truncates the stream
    there if found — see Bugs found and fixed. See Shipped and verified
    for the Vercel-specific verification story.
  - **Use-case modes** — `mode` param (`general` default, `investing`,
    `interviewing`, `selling`, `competing`). Non-general modes append one
    `MODE_SECTION_PROMPTS[mode]` block to the base system prompt, adding
    exactly one unnumbered 6th section (Diligence Notes / 5 Sharp
    Questions to Ask Their Leadership / Sales Intelligence / Competitive
    Playbook)
    without altering Sections 1–5 or the Verdict line. Logged in
    `TEARDOWN_OK`/`FAIL`. The `STATS:` instruction and the final "output
    valid markdown" bullet live in a separate `STATS_AND_FORMAT_SUFFIX`
    constant that's always concatenated *last* — after the mode block,
    not before it (`SYSTEM_PROMPT + MODE_SECTION_PROMPTS[mode] +
    STATS_AND_FORMAT_SUFFIX`) — specifically so the model has already
    been told about the mode's 6th section by the time it reads "after
    your last section, add STATS". See Bugs found and fixed for why this
    mattered.
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
  version let it bold several), compact stat strip below the Verdict
  (6 fields as of 2026-07-28, see Architecture; skipped when <2 fields
  are confidently known, dash-filled otherwise, never fabricated).
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
- **Content/format refinements** (2026-07-28) — plain unnumbered section
  headings; How They Make Money / Competitive Position / Traction
  Signals restructured to a short paragraph + 2-4 sub-bullets of
  discrete facts; stat strip expanded to 6 fields (added Revenue,
  Growth%). All three verified live against real teardowns before
  committing.
- **Analytics** — Vercel Analytics on the root layout; `TEARDOWN_OK`/
  `TEARDOWN_FAIL` structured logging grep-able in Vercel function logs.
- **Deployed** on Vercel Hobby plan; live runs confirmed no function
  timeout.
- **Streaming teardown generation** (2026-07-28) — switched `/api/teardown`
  from a single buffered `generateContent` response to `generateContentStream`
  + NDJSON over a `ReadableStream` (see Architecture). Verified in three
  stages:
  1. **Localhost**: a Python script hitting the route directly (bypassing
     the browser) logged a timestamp per NDJSON chunk — confirmed real
     incremental delivery (e.g. one run: 24 chunks between 17.1s and
     26.0s, clearly spread out, not bunched at the end), and separately
     confirmed the grounding-metadata accumulation logic works (one run
     returned 17 real sources, correctly deduped across streamed chunks).
     A Node script replicating the frontend's exact reader/buffering
     logic against the live local stream (browser tooling wasn't
     available this session — user declined the Chrome extension)
     produced 23 incremental renders for one run, confirming the
     frontend algorithm itself is correct end-to-end, not just the
     backend.
  2. **Vercel preview deployment**: pushed a `stream-teardown` branch
     (not `main`) specifically so this could be verified against real
     Vercel infrastructure without touching production — Vercel's
     GitHub integration auto-builds a preview URL per branch
     (`tearsheet-git-<branch>-<scope>.vercel.app`, discoverable via
     `GET /repos/<owner>/<repo>/commits/<sha>/check-runs`, unauthenticated,
     since the repo is public). The preview URL is protected by Vercel's
     deployment-protection SSO by default (401 to unauthenticated
     `curl`) — only the production domain is public. Ruled out the
     classic "Vercel Node.js serverless/Lambda functions buffer the
     whole response before sending, streaming needs Edge runtime"
     theory by having the user check Vercel dashboard → Settings →
     Functions: **Fluid Compute was already enabled** on this project,
     which is Vercel's newer Node.js execution model that does support
     true response streaming without needing Edge runtime (Edge would
     have required rewriting the Google Cloud service-account auth flow
     in `src/lib/gemini.ts`, which relies on Node-only APIs and almost
     certainly wouldn't run on Edge as-is — avoided that rewrite
     entirely). Final confirmation used a one-off script
     (`x-vercel-protection-bypass` header + the project's "Protection
     Bypass for Automation" secret from Vercel settings) that the user
     ran themselves in their own terminal — not via the in-session `!`
     prefix — specifically so the secret never entered the chat
     transcript, matching the standing "no secrets handoff" preference.
     Confirmed real streaming on the actual preview deployment: first
     content at ~10-15s, full completion at ~30-60s (streaming doesn't
     reduce total generation time, it just starts showing output
     sooner).
  3. **Mode-based live testing on the preview URL** surfaced a real bug
     (STATS line visible as literal text, stat strip not rendering) —
     see Bugs found and fixed. Re-verified clean after the fix, on the
     same preview URL, before merging `stream-teardown` into `main`.

## Bugs found and fixed

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

- **STATS line crammed multiple conflicting values into one field.**
  (2026-07-28) The STATS instruction told the model to fill a field only
  when confident, but didn't say what to do when its own research (per
  the contradiction-flagging rule used in prose) turned up disagreeing
  numbers for the same field — it sometimes wrote all of them into one
  cell (e.g. `Headcount=817 (Tracxn) or 4.7K (GetLatka) or 4156
  (One21)`), breaking the compact stat-tile layout, which expects one
  clean value per field. Fixed by extending the STATS instruction to
  apply the same credibility ranking already used in the main prose
  (disclosed/filed figures and funding announcements outrank aggregator
  estimates like Tracxn/GetLatka/Owler/Growjo/Prospeo; more recent
  outranks older) and require exactly one winning value per field, never
  a concatenation or inline source citation — the full disagreement
  still gets discussed in the relevant prose section (e.g. Traction
  Signals) as before. Verified via 3 direct API calls each against
  `rapido.bike` and `zomato.com`: all 6 runs rendered every one of the 6
  fields as a single clean value or a dash, never multiple values joined
  together. Figures still varied *between* separate runs (expected
  search-grounding non-determinism, see Known issues) but never *within*
  a single run's STATS line.

- **STATS line landed before the mode's 6th section instead of after
  it, and once broke entirely on trailing junk.** (2026-07-28, found
  during live streaming verification with `mode=investing` selected on
  the Vercel preview) Two compounding bugs, both in how the STATS
  instruction interacted with use-case modes:
  1. **Ordering**: the STATS instruction ("after your last section, add
     STATS") sat inside the base `SYSTEM_PROMPT`, which is concatenated
     *before* `MODE_SECTION_PROMPTS[mode]` (`SYSTEM_PROMPT +
     MODE_SECTION_PROMPTS[mode]`). At the point the model reads "your
     last section," it hasn't yet been told a 6th section is required —
     that instruction comes later in the same prompt — so it reasonably
     placed STATS right after Section 5, then added the 6th section
     after that per the later instruction, leaving STATS stranded in
     the middle of the output instead of at the true end. This only
     reproduced with a non-general mode selected; general mode (5
     sections, no appended block) was unaffected, which is why it
     wasn't caught in earlier testing. Fixed by splitting the STATS +
     output-format bullets into their own `STATS_AND_FORMAT_SUFFIX`
     constant and always appending it *last*, after the mode block:
     `SYSTEM_PROMPT + MODE_SECTION_PROMPTS[mode] +
     STATS_AND_FORMAT_SUFFIX`. No wording changed on the STATS bullet
     itself (deliberately — see the "Sources silently went missing" bug
     above for what happens when that instruction's wording gets
     touched carelessly); only its position in the concatenated prompt
     moved.
  2. **Trailing junk breaking extraction**: while investigating (1),
     found one generation where the model appended a bare list of
     citation URLs as plain text *after* the STATS line. The frontend's
     `extractStats()` required STATS to be the literal last line of the
     response (`/\n(STATS:\s*.*)$/`, anchored to end-of-string) — with
     anything trailing it, the regex simply didn't match at all, so
     *neither* the STATS line nor the junk after it got stripped, and
     the stat strip never rendered (0 fields parsed). Fixed by switching
     to `text.lastIndexOf("\nSTATS:")` plus taking everything up to that
     point as the body — finds the line wherever it is and discards it
     and anything after, rather than requiring an exact end-of-string
     match. Same behavior for the common case (STATS truly is the last
     thing), now also correct when it isn't.

  Verified via direct streaming API calls with `mode=investing` and
  `mode=interviewing` against localhost: STATS line lands after the
  6th section (`## Diligence Notes` / `## 5 Sharp Questions to Ask
  Their Leadership`) in both. A small standalone script covering 4
  cases (STATS with trailing junk, STATS as clean last line, `STATS:
  none`, and no STATS line at all — malformed output) confirmed
  `extractStats()`'s new logic handles all four correctly. Re-tested
  live on the Vercel preview with a mode selected after deploying the
  fix — user confirmed clean: no visible STATS line, stat strip
  rendered correctly.

- **Whole teardown generated twice, concatenated into one response.**
  (2026-07-28, reported live as "Sleepy Owl + Investing mode generated
  the entire output twice") First reproduced on the very first attempt
  with a single direct server request (no browser, no frontend
  involved) — this immediately ruled out a client-side double-fetch or
  double-subscribe bug. Byte-offset inspection of the raw NDJSON stream
  showed the actual mechanism: two **independent** model artifacts,
  discovered and fixed separately.
  1. **Leaked tool-call payload → full regeneration.** Right after the
     first STATS line, with no separating newline, the model
     occasionally dumps a raw `"google_search_results": [...]` JSON
     array — apparently an internal tool-call payload that isn't
     properly withheld from the visible output — and then, having
     "seen" that dump in its own context, regenerates the entire
     teardown (Verdict, all 6 sections, STATS) a second time,
     concatenated directly onto the first copy's tail. Fixed in
     `src/app/api/teardown/route.ts`: the streaming loop tracks
     accumulated text and matches it against
     `/"google_search_results"\s*:\s*\[/` on every chunk. On a match,
     it sends only the safe prefix of that chunk (everything before the
     leak), stops consuming the generator (`break`, which triggers the
     async generator's own cleanup per spec), and finalizes the stream
     normally — `done` event, sources gathered so far, logged as
     `TEARDOWN_OK domain=... category=leaked_tool_output_truncated` so
     real-world frequency is visible in production logs going forward.
     Known minor limitation (never observed live, found via a
     synthetic stress test): if the leak pattern happens to split
     exactly across a chunk boundary, a few stray characters of the
     JSON key prefix can reach the client before detection completes —
     the full duplicate content is still excluded either way.
  2. **Duplicated verdict sentence.** Separately, and independently of
     the JSON leak, the model sometimes repeats its own opening
     "Verdict: ..." sentence a second time immediately (a blank line
     between the two, then normal Section 1 content continues) —
     first noticed on `zetwerk.com`/Interviewing mode, with no leaked
     JSON and no duplicate sections, just the one sentence twice.
     `splitVerdict()` in `src/app/page.tsx` only ever stripped the
     first "Verdict:" occurrence, so the second copy rendered as a
     stray unstyled paragraph at the top of the body. Fixed by checking
     whether the text immediately following the first verdict is
     itself another verdict-shaped line, and — if the two sentences are
     the same or similar (exact match, one a substring of the other, or
     a character-bigram Dice coefficient ≥ 0.5, chosen over word-level
     Jaccard because it tolerates stemming/paraphrase differences like
     "dominates" vs "dominate" better) — skips past the duplicate before
     rendering. Deliberately handles exactly one duplicate (matching
     every real occurrence observed); 3+ consecutive repeats, never
     seen in practice, would only have the first stripped.

  **Verified via a 31-run tally across three phases** (all against
  localhost, cross-checked against `/private/tmp/tearsheet-dev.log`
  for server-side confirmation):
  - *Phase 1 — initial reproduction, pre-fix* (3 runs, all
    `sleepyowl.co.in`/Investing): 1 leak, 2 clean. Confirmed the bug is
    real but non-deterministic (~1/3 on the exact combo that triggered
    the report).
  - *Phase 2 — diverse normal-usage batch, post-leak-fix but
    pre-verdict-fix* (8 runs, 8 distinct domain/mode combinations): 7
    clean, 1 anomaly — `zetwerk.com`/Interviewing showed the verdict
    duplication (unfixed at that point in the night, which is what
    prompted fix #2 above).
  - *Phase 3 — post-both-fixes batch* (20 runs, ~15 distinct companies
    across all 5 modes, no repeated domain+mode pairs from earlier
    phases): 19 clean, 1 `verdict-duplication-caught`
    (`wave.com`/general — a **novel** occurrence, not a re-run of the
    zetwerk.com case, confirming the fix generalizes rather than being
    overfit to one company's exact wording). Zero leak recurrences.
  - **Grand total: 31 real teardown generations, 1 leak (~3%, pre-fix),
    2 verdict duplications (one pre-fix/unstripped, one post-fix/
    stripped cleanly).**

  **Confidence, stated honestly per-fix:**
  - *Verdict-duplication fix*: confirmed on live, novel data
    (`wave.com`, never tested before that run) — high confidence.
  - *Leak filter*: the leak never recurred in the 28 runs after the fix
    shipped (consistent with its low ~3% observed frequency — not
    enough volume to expect a repeat), so it has not been proven
    against a live recurrence. Confidence rests on a unit test built
    from the actual captured leak bytes (verified it truncates exactly
    at the end of the real STATS line, excludes the leak and the full
    duplicate) plus the simplicity of the code path, not on a confirmed
    live catch. Watch `category=leaked_tool_output_truncated` in
    production logs to close this gap over time.

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
- **Vercel preview deployments are behind SSO deployment protection by
  default** — `curl`/scripts get a 401 unless they send
  `x-vercel-protection-bypass: <secret>` with the project's "Protection
  Bypass for Automation" secret (Vercel dashboard → Settings →
  Deployment Protection). Only the production domain
  (`tearsheet-iota.vercel.app`) is publicly reachable without it. The
  preview URL for a given branch follows
  `tearsheet-git-<branch-slug>-<vercel-scope>.vercel.app` and can be
  discovered without any auth via GitHub's check-runs API (`GET
  /repos/amay007/tearsheet/commits/<sha>/check-runs` — the repo is
  public) even before the deploy finishes.

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
