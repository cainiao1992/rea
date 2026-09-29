const SECRET_ASSIGNMENT =
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|cookie|session)\b\s*[:=]\s*(?:Bearer\s+[A-Za-z0-9._~+/=-]+|"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

/** Redact credential-shaped substrings before approved console text is retained. */
export const redactSensitiveText = (value: string): string =>
  value
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]");
