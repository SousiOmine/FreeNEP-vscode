import { diffLines, diffWordsWithSpace } from 'diff';

export function toDiffMarkdown(prev: string, curr: string): string {
  const parts = diffLines(prev, curr);
  let md = '```diff\n';
  for (const p of parts) {
    if (p.added) {
      md += p.value.split('\n').filter(Boolean).map((l: string) => '+ ' + l).join('\n') + '\n';
    } else if (p.removed) {
      md += p.value.split('\n').filter(Boolean).map((l: string) => '- ' + l).join('\n') + '\n';
    }
  }
  md += '```';
  return md;
}

export function computePrimaryEdit(before: string, after: string): { startOffset: number; endOffset: number; insertText: string } | null {
  if (before === after) return null;
  const parts = diffWordsWithSpace(before, after) as Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
  let offsetBefore = 0;
  let startOffset: number | null = null;
  let endOffset: number | null = null;
  let insertText = '';
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (startOffset === null) {
        // Use character length, not 'count' (word count) to maintain byte-accurate offsets
        offsetBefore += part.value.length;
      } else if (startOffset !== null && endOffset === null) {
        endOffset = offsetBefore;
        break;
      }
      continue;
    }
    if (startOffset === null) startOffset = offsetBefore;
    if (part.removed) {
      offsetBefore += part.value.length;
    }
    if (part.added) {
      insertText += part.value;
    }
  }
  if (startOffset === null) return null;
  if (endOffset === null) endOffset = offsetBefore;
  return { startOffset, endOffset, insertText };
}
