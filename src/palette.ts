/**
 * Categorical series colors, validated for CVD separation and contrast against
 * both #FFFFFF and #F4F3EF. Assigned in fixed order, never cycled: anything past
 * the sixth series folds into "Other".
 */
export const SERIES = ['#009397', '#bf7b1f', '#614a96', '#58994a', '#a23951', '#4b7cba'] as const;
export const MAX_SERIES = SERIES.length;
export const OTHER_COLOR = '#aeb3b2';
export const UNATTRIBUTED_COLOR = '#cfd1cb';
export const UNTRACKED_COLOR = '#e4e3dc';

const assignments = new Map<string, string>();

/**
 * Colors for a past window, where the ranking is fixed. Chats that are also
 * colored on the page keep their hue; the rest take the free colors in order.
 */
export function seriesColorsFor(rankedKeys: string[], keep: Map<string, string> = new Map()): Map<string, string> {
  const result = new Map<string, string>();
  const visible = rankedKeys.slice(0, MAX_SERIES);
  for (const key of visible) {
    const kept = keep.get(key);
    if (kept) result.set(key, kept);
  }
  const used = new Set(result.values());
  for (const key of visible) {
    if (result.has(key)) continue;
    const free = SERIES.find((color) => !used.has(color)) ?? OTHER_COLOR;
    result.set(key, free);
    used.add(free);
  }
  return result;
}

/**
 * Color follows the entity: a chat keeps its hue while it stays on screen, and a
 * refresh that reorders the list never repaints the survivors.
 */
export function assignSeriesColors(visibleKeys: string[]): Map<string, string> {
  const visible = new Set(visibleKeys.slice(0, MAX_SERIES));
  for (const key of [...assignments.keys()]) {
    if (!visible.has(key)) assignments.delete(key);
  }
  const used = new Set(assignments.values());
  for (const key of visible) {
    if (assignments.has(key)) continue;
    const free = SERIES.find((color) => !used.has(color)) ?? OTHER_COLOR;
    assignments.set(key, free);
    used.add(free);
  }
  return new Map(assignments);
}
