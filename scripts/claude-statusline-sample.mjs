#!/usr/bin/env node
/**
 * Optional Claude Code status-line hook.
 *
 * Claude Code passes a JSON document on stdin to the configured status line
 * script after every API response. For claude.ai subscribers it includes the
 * account's rate-limit windows. This script appends those windows to the
 * dashboard's sample file, so quota samples arrive as often as Claude answers
 * instead of only when the dashboard polls, and prints a one-line status.
 *
 * Add to ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "node C:/path/to/Codex-Dashboard/scripts/claude-statusline-sample.mjs" }
 *
 * To keep an existing status line, pipe through it after this script, or set
 * CLAUDE_USAGE_SAMPLE_QUIET=1 to print nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleFile = process.env.CLAUDE_USAGE_SAMPLE_FILE
  || path.resolve(here, '..', 'data', 'claude-rate-limit-samples.jsonl');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const limits = input && typeof input === 'object' ? input.rate_limits : null;
  const pick = (window) => {
    if (!window || typeof window !== 'object') return null;
    const used = Number(window.used_percentage);
    const resetsAt = Number(window.resets_at);
    if (!Number.isFinite(used) || !Number.isFinite(resetsAt)) return null;
    return { used_percentage: used, resets_at: resetsAt };
  };
  const five = pick(limits?.five_hour);
  const seven = pick(limits?.seven_day);
  if (five || seven) {
    const line = JSON.stringify({
      observedAt: Math.floor(Date.now() / 1000),
      five_hour: five,
      seven_day: seven
    });
    try {
      fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
      fs.appendFileSync(sampleFile, `${line}\n`, 'utf8');
    } catch {
      // The status line must never fail because the dashboard folder is missing.
    }
  }
  if (process.env.CLAUDE_USAGE_SAMPLE_QUIET === '1') process.exit(0);
  const parts = [];
  if (five) parts.push(`5h ${Math.round(five.used_percentage)}%`);
  if (seven) parts.push(`7d ${Math.round(seven.used_percentage)}%`);
  const model = input?.model?.display_name;
  if (model) parts.unshift(String(model));
  process.stdout.write(parts.join(' · '));
});
