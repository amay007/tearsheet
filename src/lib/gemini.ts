import { GoogleGenAI } from "@google/genai";
import path from "node:path";

export class GenAIConfigError extends Error {}

export function createGenAIClient(): GoogleGenAI {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) {
    throw new GenAIConfigError("Server is missing GOOGLE_CLOUD_PROJECT.");
  }

  const credentialsJson = process.env.GOOGLE_CREDENTIALS_JSON;
  let googleAuthOptions;
  if (credentialsJson) {
    try {
      googleAuthOptions = { credentials: JSON.parse(credentialsJson) };
    } catch {
      throw new GenAIConfigError("GOOGLE_CREDENTIALS_JSON is not valid JSON.");
    }
  } else {
    googleAuthOptions = { keyFile: path.join(process.cwd(), "gcp-credentials.json") };
  }

  return new GoogleGenAI({
    enterprise: true,
    project,
    location,
    googleAuthOptions,
  });
}

export function categorizeGeminiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof err === "object" && err !== null ? (err as { status?: unknown; code?: unknown }).status ?? (err as { code?: unknown }).code : undefined;

  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) return "rate_limited";
  if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/i.test(message)) return "auth_error";
  if (typeof status === "number" && status >= 500) return "upstream_error";
  if (/timeout|deadline/i.test(message)) return "timeout";
  if (/ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(message)) return "network_error";
  return "unknown_error";
}

export function extractResponseText(response: { candidates?: Array<{ content?: { parts?: Array<{ thought?: boolean; text?: string }> } }> }): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}
