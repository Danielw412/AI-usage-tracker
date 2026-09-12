type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16))
    )
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10))
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  if (!isRecord(value)) return [];
  if (typeof value.text === 'string') return [value.text];
  if (typeof value.message === 'string') return [value.message];
  return textParts(value.content);
}

export function extractRawUserMessage(record: JsonRecord): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;

  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : null;
  }

  if (
    record.type === 'response_item' &&
    payload.type === 'message' &&
    payload.role === 'user'
  ) {
    const parts = textParts(payload.content);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (record.type === 'event_msg' && payload.type === 'item_completed') {
    const item = isRecord(payload.item) ? payload.item : null;
    if (String(item?.type).toLowerCase() !== 'usermessage') return null;
    const parts = textParts(item?.content);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  return null;
}

export function cleanUserMessage(message: string, maxLength = 1000): string | null {
  let text = message.replace(/\r\n/g, '\n').trim();
  const requestMarkers = [...text.matchAll(/##\s*My request(?:\s+for Codex)?:\s*/gi)];
  const requestMarker = requestMarkers.at(-1);
  if (requestMarker?.index !== undefined) {
    text = text.slice(requestMarker.index + requestMarker[0].length).trim();
  }

  text = text
    .replace(/<image\b[\s\S]*?<\/image>/gi, ' ')
    .replace(/<image\b[^>]*>/gi, ' ')
    // Plugin and app mentions arrive as markdown links; keep only the mention.
    .replace(/\[(@?[^\]]+)\]\((?:plugin|app|skill|mcp):\/\/[^)]*\)/gi, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
  const normalized = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (
    /^the following is the codex agent (?:history|transcript)/i.test(normalized) ||
    /^continue the same review conversation/i.test(normalized) ||
    /^<recommended_plugins>/i.test(normalized) ||
    /^#\s*AGENTS\.md instructions/i.test(normalized) ||
    /^<(?:app-context|apps_instructions|collaboration_mode|environment_context|permissions instructions|plugins_instructions|skills_instructions)>/i.test(normalized)
  ) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

export function cleanDisplayText(value: string | null, maxLength = 300): string | null {
  return value === null ? null : cleanUserMessage(value, maxLength);
}
