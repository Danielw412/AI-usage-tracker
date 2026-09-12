import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `~/.claude`, or `CLAUDE_CONFIG_DIR` when Claude Code is configured to live elsewhere. */
export function claudeConfigDir(): string {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

/** Session transcripts: `<config>/projects/<encoded cwd>/<session id>.jsonl`. */
export function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/** One small JSON file per running Claude Code process. */
export function claudeSessionsDir(): string {
  return path.join(claudeConfigDir(), 'sessions');
}

/** OAuth credentials on Windows and Linux. macOS keeps them in the keychain. */
export function claudeCredentialsFile(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

/**
 * The global state file (`~/.claude.json`) holds the signed-in account and the
 * utilization snapshot Claude Code cached the last time `/usage` ran. With
 * `CLAUDE_CONFIG_DIR` set, Claude Code keeps it inside that directory instead.
 */
export function claudeConfigFile(): string {
  const inDirectory = path.join(claudeConfigDir(), '.claude.json');
  if (process.env.CLAUDE_CONFIG_DIR && fs.existsSync(inDirectory)) return inDirectory;
  const home = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(home)) return home;
  return inDirectory;
}
