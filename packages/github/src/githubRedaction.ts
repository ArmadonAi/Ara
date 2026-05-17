/**
 * Redact GitHub tokens from strings.
 * Never log tokens: ghp_*, github_pat_*, Authorization headers, fine-grained PATs.
 */
export function redactGitHubSecret(str: string): string {
  if (!str || typeof str !== 'string') return str;
  return str
    // Classic PAT: ghp_ followed by 36+ alphanumeric
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    // Fine-grained PAT: github_pat_ followed by 4+ chars, underscore, 20+ chars
    .replace(/github_pat_[a-zA-Z0-9_-]{30,}/g, '[REDACTED]')
    // Authorization header values
    .replace(/(Authorization|authorization):\s*Bearer\s+\S+/g, '$1: [REDACTED]')
    // Token query params
    .replace(/[?&](token|access_token)=\S+/g, '&$1=[REDACTED]');
}

/**
 * Redact an entire object's string values recursively.
 */
export function redactGitHubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = redactGitHubSecret(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactGitHubObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        typeof v === 'string' ? redactGitHubSecret(v) :
        v && typeof v === 'object' ? redactGitHubObject(v) : v
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
