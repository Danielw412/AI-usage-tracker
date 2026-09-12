import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { claudeCredentialsFile } from './paths.js';

export interface ClaudeCredentials {
  accessToken: string;
  /** Unix seconds, or null when the token has no known expiry. */
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  source: 'env' | 'file' | 'keychain';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function credentialsFromPayload(
  payload: unknown,
  source: ClaudeCredentials['source']
): ClaudeCredentials | null {
  if (!isRecord(payload)) return null;
  const oauth = isRecord(payload.claudeAiOauth) ? payload.claudeAiOauth : payload;
  const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!accessToken) return null;
  const expiresRaw = oauth.expiresAt;
  const expiresAt = typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)
    ? Math.round(expiresRaw > 10_000_000_000 ? expiresRaw / 1000 : expiresRaw)
    : null;
  return {
    accessToken,
    expiresAt,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
    source
  };
}

function readKeychain(timeoutMs = 5000): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) resolve(null);
        else resolve(stdout.trim() || null);
      }
    );
  });
}

/**
 * Locate the OAuth token Claude Code signed in with. Sources, in order: the
 * `CLAUDE_CODE_OAUTH_TOKEN` environment variable (from `claude setup-token`),
 * `<config>/.credentials.json`, then the macOS keychain. The token is only ever
 * held in memory and sent to Anthropic's usage endpoint; it is never logged.
 */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) {
    return { accessToken: fromEnv, expiresAt: null, subscriptionType: null, rateLimitTier: null, source: 'env' };
  }

  const file = claudeCredentialsFile();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
      const credentials = credentialsFromPayload(parsed, 'file');
      if (credentials) return credentials;
    } catch {
      // Fall through to the keychain; a half-written file is retried next poll.
    }
  }

  const keychain = await readKeychain();
  if (keychain) {
    try {
      return credentialsFromPayload(JSON.parse(keychain) as unknown, 'keychain');
    } catch {
      return null;
    }
  }
  return null;
}

export function credentialsExpired(credentials: ClaudeCredentials, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return credentials.expiresAt !== null && credentials.expiresAt <= nowSeconds;
}
