export function compact(value: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: digits
  }).format(value);
}

export function integer(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function percent(value: number | null, digits?: number): string {
  if (value === null || Number.isNaN(value)) return '-';
  const resolved = digits ?? (Math.abs(value) < 10 ? 1 : 0);
  return `${value.toFixed(resolved)}%`;
}

export function usd(value: number | null, digits = 2): string {
  if (value === null) return '-';
  const resolved = Math.abs(value) >= 1000 ? 0 : digits;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: resolved,
    maximumFractionDigits: resolved
  }).format(value);
}

export function sentence(value: string | null): string | null {
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** Temp workspaces are named by hash; those are not useful as a project label. */
export function readableProject(name: string | null): string | null {
  if (!name) return null;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(name) || /^[0-9a-f]{24,}$/i.test(name)) return null;
  return name;
}

export function clock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(timestamp: number | null): string {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function relativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return 'Unknown';
  const seconds = Math.round(now / 1000 - timestamp);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function duration(milliseconds: number | null): string {
  if (milliseconds === null) return '-';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes < 60) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function countdown(seconds: number): string {
  if (seconds <= 0) return 'now';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

export function weekdayShort(index: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][index] ?? '';
}

export function projectFromPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/^\\\\\?\\/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

export const SOURCE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  cli: 'CLI',
  ide: 'IDE',
  exec: 'Script',
  cloud: 'Cloud',
  voice: 'Voice',
  review: 'Review',
  subagent: 'Subagent',
  unknown: 'Local'
};

/**
 * Trim provider prefixes and version noise so model names read cleanly in
 * tight columns: "openai/gpt-5" -> "gpt-5", "claude-haiku-4-5-20251001[1m]"
 * -> "claude-haiku-4-5".
 */
export function modelLabel(model: string): string {
  if (model === 'unknown') return 'Unknown model';
  if (model === 'codex-auto-review') return 'Auto-review';
  return model
    .replace(/^openai\//, '')
    .replace(/\s*\[1m\]$/i, '')
    .replace(/-\d{8}$/, '');
}
