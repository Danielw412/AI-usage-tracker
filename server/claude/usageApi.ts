/**
 * The endpoint behind Claude Code's `/usage` screen. It is not part of the
 * public API surface, so every field is treated as optional and the response is
 * normalized in `normalize.ts`.
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export class ClaudeUsageError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = 'ClaudeUsageError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export async function fetchClaudeUsage(accessToken: string, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        Accept: 'application/json',
        'User-Agent': 'ai-usage-tracker'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        detail = body?.error?.message ? `: ${body.error.message}` : '';
      } catch {
        // Non-JSON error bodies carry nothing useful.
      }
      const message = response.status === 429
        ? 'Claude usage endpoint is rate limited'
        : response.status === 401 || response.status === 403
          ? 'Claude Code login was rejected; open Claude Code to refresh the sign-in'
          : `Claude usage endpoint returned ${response.status}${detail}`;
      throw new ClaudeUsageError(message, response.status, parseRetryAfter(response.headers.get('retry-after')));
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof ClaudeUsageError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new ClaudeUsageError(`Claude usage endpoint timed out after ${timeoutMs}ms`, 0, null);
    }
    throw new ClaudeUsageError(`Claude usage endpoint unreachable: ${(error as Error).message}`, 0, null);
  } finally {
    clearTimeout(timer);
  }
}
