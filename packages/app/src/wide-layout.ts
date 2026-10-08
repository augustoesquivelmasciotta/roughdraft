// A GFM table has a header row followed by a delimiter row such as
// "| --- | :---: |". Code fences can show the same text, so they are skipped.
const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function markdownHasTable(markdown: string): boolean {
  let inFence = false;
  let previousHasPipe = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      previousHasPipe = false;
      continue;
    }
    if (inFence) continue;
    if (previousHasPipe && TABLE_DELIMITER_ROW.test(line)) return true;
    previousHasPipe = line.includes("|");
  }
  return false;
}
