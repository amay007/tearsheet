import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { normalizeCompanyUrl } from "@/lib/companyUrl";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const maxDuration = 120;

const GENERIC_ERROR = "Something went wrong generating this teardown. Please try again in a minute.";
const MAX_BODY_BYTES = 10_000;

const SYSTEM_PROMPT = `You are a sharp, skeptical company analyst producing a "teardown" for a founder or investor who has ten minutes and no patience for fluff.

You will be given a company website URL. Use Google Search to read the site itself and to find independent information about the company: funding rounds, press coverage, reviews, job postings, competitor commentary, pricing changes, executive departures, etc.

Produce a teardown with EXACTLY these five sections, in this order, each as a markdown heading:

## 1. How They Make Money
## 2. Competitive Position
## 3. Traction Signals
## 4. Fragilities
## 5. The 3 Questions Leadership Is Debating Right Now

Hard requirements:
- Every non-trivial claim must carry an inline evidence citation in parentheses, e.g. "(per their pricing page)", "(per their Series B announcement)", "(per a 2024 TechCrunch report)", "(per a Glassdoor review from an ex-employee)". If you cannot find evidence for a claim, do not make the claim.
- Write in short, dense paragraphs or tight bullet lists. No throat-clearing, no "In today's competitive landscape...", no restating the company's own marketing copy as if it were analysis.
- Banned filler: generic phrases like "innovative solutions", "cutting-edge", "customer-centric", "leverage synergies", "disruptive", "world-class", "seamless experience", "unlock value" — do not use these unless directly quoting a source, and if you quote them, mark it as marketing language, not analysis.
- If sources disagree on a number (funding, revenue, valuation, headcount, etc.), do not average them or quietly pick one. Explicitly flag the contradiction, state each figure with its source, and say which one you find more credible and why. Treat revenue estimates from aggregators like Growjo, Prospeo, and Owler as low-confidence, modeled guesses — label them as such (e.g. "per Growjo's modeled estimate, low-confidence") and never present them with the same authority as a disclosed number from the company, a filing, or a funding announcement.
- Section 1 (How They Make Money) must analyze the business model, not describe the product: who actually pays, how pricing scales with usage or seats, what expansion/upsell looks like, and typical deal size. Do not summarize features or restate the homepage.
- Section 4 (Fragilities) must identify real, specific risks (financial, competitive, technical, key-person, regulatory, churn signals) tied to evidence about THIS company. Ban any fragility that would apply to almost any company in the category ("competition could intensify," "the market could change," "reliance on a small team") unless you attach specific evidence that makes it true here.
- Section 5 must contain exactly 3 items, each a single, sharp, non-obvious question — phrased the way the founder or CEO would actually frame it to themselves at 2am, not a multi-part consulting-framework question with several clauses stitched together. If a question needs "and" to hold two ideas, split it or cut one.
- If the evidence surfaces an anomaly — e.g. headcount growing while revenue estimates shrink, funding raised without matching hiring, glowing reviews alongside a spike in negative Glassdoor sentiment — do not just state both facts side by side and move on. Call out the tension explicitly and interrogate what it implies.
- If the site or search results are thin, say so explicitly rather than inventing detail. It is better to write "Traction Signals: no public funding or usage data found (searched their press page and general web) — this is itself a signal of an early-stage or quiet company" than to fabricate numbers.
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

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) {
    console.error("Server is missing GOOGLE_CLOUD_PROJECT.");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  let rawUrl: string;
  try {
    const body = await req.json();
    rawUrl = typeof body?.url === "string" ? body.url : "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const normalized = normalizeCompanyUrl(rawUrl);
  if (normalized.error) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const normalizedUrl = normalized.url;

  const ai = new GoogleGenAI({
    enterprise: true,
    project,
    location,
    googleAuthOptions: {
      keyFile: path.join(process.cwd(), "gcp-credentials.json"),
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Company website: ${normalizedUrl}\n\nRead this site and search for independent, current information about this company (funding, news, reviews, competitors). Then produce the teardown following the required structure exactly.`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
      },
    });

    const text = (response.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!text) {
      console.error("Gemini generateContent returned an empty response.");
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
    }

    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const sources = (groundingMetadata?.groundingChunks ?? [])
      .map((chunk) => chunk.web)
      .filter((web): web is { uri?: string; title?: string } => Boolean(web?.uri))
      .map((web) => ({ uri: web.uri as string, title: web.title || web.uri || "" }));

    const uniqueSources = Array.from(new Map(sources.map((s) => [s.uri, s])).values());

    return NextResponse.json({ text, sources: uniqueSources });
  } catch (err) {
    console.error("Gemini generateContent failed:", err);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
  }
}
