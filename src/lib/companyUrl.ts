export const MAX_COMPANY_URL_LENGTH = 200;

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export type NormalizeResult = { url: string; error?: undefined } | { url?: undefined; error: string };

export function normalizeCompanyUrl(input: string): NormalizeResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { error: "Enter a company URL to get started." };
  }

  if (trimmed.length > MAX_COMPANY_URL_LENGTH) {
    return { error: `That URL is too long — please keep it under ${MAX_COMPANY_URL_LENGTH} characters.` };
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
