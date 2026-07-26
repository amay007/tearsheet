export const MAX_INPUT_LENGTH = 200;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const TLD_PATTERN = /^[a-z]{2,24}$/i;

export type NormalizeResult = { url: string; error?: undefined } | { url?: undefined; error: string };

export function normalizeCompanyUrl(input: string): NormalizeResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { error: "Enter a company URL to get started." };
  }

  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { error: `That URL is too long — please keep it under ${MAX_INPUT_LENGTH} characters.` };
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return { error: "That doesn't look like a valid domain (e.g. stripe.com)." };
  }

  if (!DOMAIN_PATTERN.test(parsed.hostname)) {
    return { error: "That doesn't look like a valid domain (e.g. stripe.com)." };
  }

  return { url: parsed.toString() };
}

export type ValidateResult = { ok: true; trimmed: string } | { ok: false; error: string };

export function validateInput(input: string): ValidateResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, error: "Enter a company name or URL to get started." };
  }

  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: `That's too long — please keep it under ${MAX_INPUT_LENGTH} characters.` };
  }

  return { ok: true, trimmed };
}

function isUrlShaped(trimmed: string): boolean {
  if (/\s/.test(trimmed) || !trimmed.includes(".")) return false;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let hostname: string;
  try {
    hostname = new URL(withProtocol).hostname;
  } catch {
    return false;
  }

  if (!DOMAIN_PATTERN.test(hostname)) return false;

  const tld = hostname.slice(hostname.lastIndexOf(".") + 1);
  return TLD_PATTERN.test(tld);
}

export type ClassifyResult =
  | { kind: "url"; url: string }
  | { kind: "name"; name: string }
  | { kind: "error"; error: string };

export function classifyCompanyInput(input: string): ClassifyResult {
  const validated = validateInput(input);
  if (!validated.ok) {
    return { kind: "error", error: validated.error };
  }

  const { trimmed } = validated;

  if (isUrlShaped(trimmed)) {
    const normalized = normalizeCompanyUrl(trimmed);
    if (normalized.error) {
      return { kind: "error", error: normalized.error };
    }
    // normalized.url is guaranteed set here (mirrors the cast used in the teardown route).
    return { kind: "url", url: normalized.url as string };
  }

  return { kind: "name", name: trimmed };
}
