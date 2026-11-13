export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

export function redactSecrets(message: string): string {
  let sanitized = message;
  for (const name of ["YOUTUBE_API_KEY", "LLM_API_KEY", "RESEND_API_KEY"]) {
    const secret = process.env[name];
    if (secret) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bre_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}
