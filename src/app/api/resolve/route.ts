import { NextRequest, NextResponse } from "next/server";
import { normalizeCompanyUrl, validateInput } from "@/lib/companyUrl";
import { checkResolveRateLimit, getClientIp } from "@/lib/rateLimit";
import { categorizeGeminiError, createGenAIClient, extractResponseText } from "@/lib/gemini";

export const maxDuration = 30;

const GENERIC_ERROR = "Something went wrong looking that up. Please try again in a minute.";
const NOT_FOUND_ERROR = "Couldn't find a company matching that — check the spelling or paste their website URL.";
const MAX_BODY_BYTES = 2_000;

type Confidence = "high" | "medium" | "low";
type Match = { name: string; oneLineDescriptor: string; domain: string; confidence: Confidence };

const SYSTEM_PROMPT = `You identify which real company or companies a user's search text refers to, using Google Search.

Rules:
- The input may be misspelled, abbreviated, or ambiguous. Use search and judgment to resolve the most likely intended real company or companies, correcting obvious typos.
- If one real company is clearly the dominant, well-known referent for this name (e.g. a funded startup, public company, or widely recognized brand), return an array containing exactly that one entry — even if small, obscure, or unrelated businesses happen to share a similar name. Do not pad the list with minor lookalikes just to fill space.
- Only return multiple candidates (top 2 to 3, ordered by likelihood) when there is genuine ambiguity between real companies of comparable size or prominence, such that a reasonable person could mean either one.
- If you cannot find any real company that plausibly matches, return an empty array.
- If nothing matches, return exactly [].
- Never invent a company or domain you cannot support with search results.

Respond with ONLY a strict JSON array — no markdown code fences, no commentary, no wrapper object. Each element must have exactly these fields:
[{"name": string, "oneLineDescriptor": string, "domain": string, "confidence": "high" | "medium" | "low"}]

"oneLineDescriptor" is a short factual phrase under 8 words describing what the company does (e.g. "B2B manufacturing marketplace"). "domain" is the company's primary website domain with no protocol (e.g. "stripe.com"). Output nothing besides the JSON array.`;

// The model is instructed to output raw JSON only, but under some inputs it still
// prefaces the array with reasoning prose and/or wraps it in a code fence. Pull the
// array out of whatever we got rather than requiring the whole response to be clean JSON.
function extractJsonArrayText(raw: string): string {
  const trimmed = raw.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function parseMatches(raw: string): Match[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArrayText(raw));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const matches: Match[] = [];
  for (const item of parsed) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).oneLineDescriptor !== "string" ||
      typeof (item as Record<string, unknown>).domain !== "string" ||
      !["high", "medium", "low"].includes((item as Record<string, unknown>).confidence as string)
    ) {
      continue; // drop a single malformed entry rather than failing the whole batch
    }
    if (normalizeCompanyUrl((item as Match).domain).error) {
      continue; // drop entries whose "domain" isn't actually domain-shaped (e.g. "N/A")
    }
    matches.push(item as Match);
  }

  return matches.slice(0, 3);
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req.headers);
  const rateLimit = checkResolveRateLimit(clientIp);
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

  let rawName: string;
  try {
    const body = await req.json();
    rawName = typeof body?.name === "string" ? body.name : "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const validated = validateInput(rawName);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const name = validated.trimmed;

  let ai;
  try {
    ai = createGenAIClient();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: `Company name or search text: "${name}"` }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 256 },
      },
    });

    const text = extractResponseText(response);
    const duration = Math.round((Date.now() - startTime) / 1000);

    const matches = text ? parseMatches(text) : null;
    if (matches === null) {
      // A failed lookup reads the same as a no-match to the user — the friendly message covers
      // both. Raw text stays server-side for debugging (see NOTES.md: resolve parse-failure root cause).
      console.error("Resolve: failed to parse model output as a matches JSON array. Raw text:", text);
      console.log(`RESOLVE_FAIL name=${name} duration=${duration}s category=parse_error`);
      return NextResponse.json({ error: NOT_FOUND_ERROR }, { status: 404 });
    }

    if (matches.length === 0) {
      console.log(`RESOLVE_FAIL name=${name} duration=${duration}s category=no_match`);
      return NextResponse.json({ error: NOT_FOUND_ERROR }, { status: 404 });
    }

    if (matches.length === 1) {
      console.log(`RESOLVE_OK name=${name} → domain=${matches[0].domain} duration=${duration}s`);
    } else {
      console.log(`RESOLVE_AMBIGUOUS name=${name} count=${matches.length} duration=${duration}s`);
    }

    return NextResponse.json({ matches });
  } catch (err) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    console.error("Gemini resolve call failed:", err);
    console.log(`RESOLVE_FAIL name=${name} duration=${duration}s category=${categorizeGeminiError(err)}`);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 502 });
  }
}
