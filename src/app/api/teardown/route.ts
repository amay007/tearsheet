import { NextRequest, NextResponse } from "next/server";
import { normalizeCompanyUrl } from "@/lib/companyUrl";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { categorizeGeminiError, createGenAIClient, extractResponseText } from "@/lib/gemini";

export const maxDuration = 120;

const GENERIC_ERROR = "Something went wrong generating this teardown. Please try again in a minute.";
const MAX_BODY_BYTES = 10_000;

export type Mode = "general" | "investing" | "interviewing" | "selling" | "competing";

const MODES: Mode[] = ["general", "investing", "interviewing", "selling", "competing"];

function parseMode(value: unknown): Mode {
  return typeof value === "string" && (MODES as string[]).includes(value) ? (value as Mode) : "general";
}

const MODE_SECTION_PROMPTS: Record<Exclude<Mode, "general">, string> = {
  investing: `

Additionally, because this teardown is being read by someone deciding whether to invest, add a sixth section after Section 5 with exactly this heading (no number prefix):

## Diligence Notes

List the specific, unresolved items a diligence process should chase before wiring money — each tied to a concrete gap, contradiction, or unverifiable claim surfaced above (e.g. a number only one low-confidence source supports, a metric management hasn't disclosed, a claim that contradicts a public filing or review). Do not include generic checklist boilerplate ("review the cap table", "check references") unless you attach a specific reason it matters here. 4-6 tight bullets. This section is purely additive — it does not change Sections 1-5 or the Verdict line.`,
  interviewing: `

Additionally, because this teardown is being read by someone interviewing at this company, add a sixth section after Section 5 with exactly this heading (no number prefix):

## 5 Sharp Questions to Ask Their Leadership

Exactly 5 questions a sharp candidate would ask a hiring manager or exec to pressure-test the fragilities and anomalies found above — phrased the way a person would actually ask them out loud, not consulting-speak. Each question must be traceable to a specific fact or tension surfaced earlier in this analysis. One idea per question; split or cut anything joined by "and". This section is purely additive — it does not change Sections 1-5 or the Verdict line.`,
  selling: `

Additionally, because this teardown is being read by someone selling into this company, add a sixth section after Section 5 with exactly this heading (no number prefix):

## Sales Intelligence

3-5 tight bullets covering: the likely economic buyer or decision-making function (based on org structure, job postings, or org-chart evidence), concrete buying signals (recent funding, hiring surges in a specific function, tool/vendor switches, expansion into new markets), and the single sharpest wedge — a gap or fragility from the analysis above a pitch could be built around. Tie every bullet to evidence; do not guess at a buyer persona with no supporting signal. This section is purely additive — it does not change Sections 1-5 or the Verdict line.`,
  competing: `

Additionally, because this teardown is being read by someone competing directly with this company, add a sixth section after Section 5 with exactly this heading (no number prefix):

## Competitive Playbook

3-5 tight bullets, each naming a specific segment, feature gap, pricing weakness, or churn signal from the analysis above that is most exploitable, paired with the concrete positioning wedge to attack it. Ban generic playbook advice ("compete on service", "move faster") unless tied to a specific piece of evidence about this company. This section is purely additive — it does not change Sections 1-5 or the Verdict line.`,
};

const SYSTEM_PROMPT = `You are a sharp, skeptical company analyst producing a "teardown" for a founder or investor who has ten minutes and no patience for fluff.

You will be given a company website URL. Use Google Search to read the site itself and to find independent information about the company: funding rounds, press coverage, reviews, job postings, competitor commentary, pricing changes, executive departures, etc.

Begin your output with a single line formatted as "Verdict: [one sentence]" — your sharpest one-sentence take on this company, committed and specific, synthesizing the whole analysis. No hedging words (may, could, potentially). This line comes before Section 1 and replaces any title line — never output a title heading.

Then produce a teardown with EXACTLY these five sections, in this order, each as a markdown heading. Do not number the headings — no "1.", "2.", etc. prefix; use the plain title text exactly as written below:

## How They Make Money
## Competitive Position
## Traction Signals
## Fragilities
## The 3 Questions Leadership Is Debating Right Now

Hard requirements:
- Anchor every search and every fact strictly to the specific company at the given domain. If a search result appears to be about a different company that merely has a similar or identical-sounding name (a name collision), do not use it — verify the result actually matches this company (its domain, product, founders, or other confirmed details) before treating it as evidence. This matters most for companies with thin search footprints, where a more prominent similarly-named company can otherwise dominate the results.
- Every non-trivial claim must carry an inline evidence citation in parentheses, e.g. "(per their pricing page)", "(per their Series B announcement)", "(per a 2024 TechCrunch report)", "(per a Glassdoor review from an ex-employee)". If you cannot find evidence for a claim, do not make the claim.
- Write in short, dense paragraphs or tight bullet lists. No throat-clearing, no "In today's competitive landscape...", no restating the company's own marketing copy as if it were analysis.
- Banned filler: generic phrases like "innovative solutions", "cutting-edge", "customer-centric", "leverage synergies", "disruptive", "world-class", "seamless experience", "unlock value" — do not use these unless directly quoting a source, and if you quote them, mark it as marketing language, not analysis.
- If sources disagree on a number (funding, revenue, valuation, headcount, etc.), do not average them or quietly pick one. Explicitly flag the contradiction, state each figure with its source, and say which one you find more credible and why. Treat revenue estimates from aggregators like Growjo, Prospeo, and Owler as low-confidence, modeled guesses — label them as such (e.g. "per Growjo's modeled estimate, low-confidence") and never present them with the same authority as a disclosed number from the company, a filing, or a funding announcement.
- Section 1 (How They Make Money) must analyze the business model, not describe the product: who actually pays, how pricing scales with usage or seats, what expansion/upsell looks like, and typical deal size. Do not summarize features or restate the homepage.
- How They Make Money, Competitive Position, and Traction Signals must each open with a short paragraph (2-3 sentences) framing that section's core point, then break into 2-4 sub-bullets listing the discrete, citation-backed facts (specific numbers, named competitors, funding rounds, dates) — do not bury these facts inside one dense paragraph block.
- Section 4 (Fragilities) must be written as a markdown bulleted list — one bullet per fragility, never continuous prose paragraphs. Each bullet must identify a real, specific risk (financial, competitive, technical, key-person, regulatory, churn signals) tied to evidence about THIS company. Ban any fragility that would apply to almost any company in the category ("competition could intensify," "the market could change," "reliance on a small team") unless you attach specific evidence that makes it true here.
- Section 5 must contain exactly 3 items, each a single, sharp, non-obvious question — phrased the way the founder or CEO would actually frame it to themselves at 2am, not a multi-part consulting-framework question with several clauses stitched together. If a question needs "and" to hold two ideas, split it or cut one.
- If the evidence surfaces an anomaly — e.g. headcount growing while revenue estimates shrink, funding raised without matching hiring, glowing reviews alongside a spike in negative Glassdoor sentiment — do not just state both facts side by side and move on. Call out the tension explicitly and interrogate what it implies.
- If the site or search results are thin, say so explicitly rather than inventing detail. It is better to write "Traction Signals: no public funding or usage data found (searched their press page and general web) — this is itself a signal of an early-stage or quiet company" than to fabricate numbers.
- If a given section turned up few or no independent sources to support its claims, say so explicitly in that section (e.g. "limited independent sourcing was found for this section — treat the following with extra caution") rather than presenting it in the same confident tone as a well-sourced section.
- In each section, you may bold AT MOST ONE figure total — the single most decisive number for that section's point (the one that resolves a contradiction, defines runway, or reveals the anomaly), wrapped in markdown bold (**like this**). Every other number in that section — other dollar figures, percentages, dates, plan names — must stay plain, unbolded text, even if it looks notable. If nothing is clearly the single most decisive figure, bold nothing in that section. Most sections should have zero bolded figures; none should ever have more than one.
- After your last section, add one more line starting with "STATS:" giving six facts from your research above, separated by " | ": Founded=<year or ->, Funding=<total raised or ->, Headcount=<figure or ->, HQ=<city, country or ->, Revenue=<figure or ->, Growth=<percentage or ->. Each field must contain exactly ONE value — never concatenate multiple figures, never write "X or Y", never cite sources or disagreement inline in this line. If your research turned up conflicting numbers for a field (as in the contradiction-flagging rule above), do not put more than one of them here: apply the same credibility ranking you used in the prose — a disclosed/filed figure or funding announcement outranks an aggregator's modeled estimate (Tracxn, GetLatka, Owler, Growjo, Prospeo, etc.), and a more recent figure outranks an older one — and put only the single winning value in this field. The full disagreement and both figures still belong in the relevant prose section (e.g. Traction Signals) as usual; this line only ever gets the one figure you'd stand behind. Only fill in a field you found confident, well-sourced evidence for elsewhere in your research; use a dash for anything you're not confident about — never guess a value just to fill the field. Revenue and Growth are usually undisclosed for private companies — a dash for both is expected and fine. If fewer than 2 of the 6 fields are confidently known, write "STATS: none" instead.
- Output valid markdown. Do not wrap the whole response in a code block.`;

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req.headers);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "You've hit the limit — try again in a bit." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }

  let rawUrl: string;
  let mode: Mode;
  let companyName: string | undefined;
  let companyDescriptor: string | undefined;
  try {
    const body = await req.json();
    rawUrl = typeof body?.url === "string" ? body.url : "";
    mode = parseMode(body?.mode);
    companyName = typeof body?.companyName === "string" ? body.companyName.trim().slice(0, 200) || undefined : undefined;
    companyDescriptor =
      typeof body?.companyDescriptor === "string" ? body.companyDescriptor.trim().slice(0, 200) || undefined : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const normalized = normalizeCompanyUrl(rawUrl);
  if (normalized.error) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const normalizedUrl = normalized.url;

  let ai;
  try {
    ai = createGenAIClient();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  const domain = new URL(normalizedUrl as string).hostname;
  const startTime = Date.now();

  const hasVerifiedIdentity = Boolean(companyName && companyName.toLowerCase() !== domain.toLowerCase());
  const identityAnchor = hasVerifiedIdentity
    ? ` This company operates under the name "${companyName}"${companyDescriptor ? ` — ${companyDescriptor}` : ""} at the domain ${domain}. The domain ${domain} is the ground truth for which company you are analyzing. Be aware that more than one real company — even in the same country and same line of business — can share this exact name; a same-name, same-industry company is NOT automatically the same company as the one at this domain. Before using any fact from a search result, confirm it is actually tied to ${domain} specifically (the result mentions, links to, or is clearly about the company running this exact site) — not merely a company with the same or a similar name and a similar-sounding business. If you cannot confirm a result belongs to ${domain}, do not use it, and say explicitly that a fact (e.g. funding, founding year) could not be confirmed for this specific company rather than reporting a number that may belong to a different, same-named company.`
    : "";

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Company website: ${normalizedUrl}\n\nRead this site and search for independent, current information about this company (funding, news, reviews, competitors).${identityAnchor} Then produce the teardown following the required structure exactly.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction:
          mode === "general" ? SYSTEM_PROMPT : SYSTEM_PROMPT + MODE_SECTION_PROMPTS[mode],
        tools: [{ googleSearch: {} }],
      },
    });

    const text = extractResponseText(response);
    if (!text) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.error("Gemini generateContent returned an empty response.");
      console.log(`TEARDOWN_FAIL domain=${domain} duration=${duration}s mode=${mode} category=empty_response`);
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const sources = (groundingMetadata?.groundingChunks ?? [])
      .map((chunk) => chunk.web)
      .filter((web): web is { uri?: string; title?: string } => Boolean(web?.uri))
      .map((web) => ({ uri: web.uri as string, title: web.title || web.uri || "" }));

    const uniqueSources = Array.from(new Map(sources.map((s) => [s.uri, s])).values());

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`TEARDOWN_OK domain=${domain} duration=${duration}s mode=${mode}`);

    return NextResponse.json({ text, sources: uniqueSources });
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.error("Gemini generateContent failed:", err);
    console.log(`TEARDOWN_FAIL domain=${domain} duration=${duration}s mode=${mode} category=${categorizeGeminiError(err)}`);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
  }
}
