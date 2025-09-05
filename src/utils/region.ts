export const CURSOR_MARKER = '<|user_cursor_is_here|>';
export const REGION_START = '<|editable_region_start|>';
export const REGION_END = '<|editable_region_end|>';

export function makeRegionInput(before: string, after: string): string {
  return `${REGION_START}\n${before}${CURSOR_MARKER}${after}\n${REGION_END}`;
}

export function extractRegionFromOutput(text: string): { regionOut: string | null; think?: string } {
  if (!text) return { regionOut: null };
  const cleaned = text
    .replace(/^```(json|text)?/i, '')
    .replace(/```$/,'')
    .trim();
  let think: string | undefined;
  const thinkStart = cleaned.indexOf('<think>');
  const thinkEnd = cleaned.indexOf('</think>');
  let body = cleaned;
  if (thinkStart !== -1 && thinkEnd !== -1 && thinkEnd > thinkStart) {
    think = cleaned.slice(thinkStart + 7, thinkEnd).trim();
    body = (cleaned.slice(0, thinkStart) + cleaned.slice(thinkEnd + 8)).trim();
  }
  const startIdx = body.indexOf(REGION_START);
  const endIdx = body.indexOf(REGION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { regionOut: null };
  const inner = body.slice(startIdx + REGION_START.length, endIdx);
  return { regionOut: inner.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''), think };
}

