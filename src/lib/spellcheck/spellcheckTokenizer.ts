import type { Node as ProseMirrorNode } from "@milkdown/prose/model";
import type { SpellcheckToken } from "../../models/spellcheck";

const WORD_REGEX = /\p{L}+(?:[’'-]\p{L}+)*/gu;
const IGNORED_TEXT_REGEXES = [
  /\b(?:https?:\/\/|www\.)\S+\b/gu,
  /\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu,
  /\b[\p{L}\p{N}._-]+[\\/][^\s]*/gu
];

function overlapsIgnoredRange(start: number, end: number, ignoredRanges: Array<{ start: number; end: number }>) {
  return ignoredRanges.some((range) => start < range.end && end > range.start);
}

function getIgnoredRanges(text: string) {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const expression of IGNORED_TEXT_REGEXES) {
    expression.lastIndex = 0;

    for (const match of text.matchAll(expression)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
    }
  }

  return ranges;
}

function shouldSkipTextNode(node: ProseMirrorNode, parent: ProseMirrorNode | null) {
  if (!node.isText || !parent) {
    return true;
  }

  if (!node.text || parent.type.spec.code) {
    return true;
  }

  return node.marks.some((mark) => mark.type.name === "code");
}

export function collectSpellcheckTokens(doc: ProseMirrorNode): SpellcheckToken[] {
  const tokens: SpellcheckToken[] = [];

  doc.descendants((node, pos, parent) => {
    if (shouldSkipTextNode(node, parent)) {
      return;
    }

    const text = node.text ?? "";
    const ignoredRanges = getIgnoredRanges(text);
    WORD_REGEX.lastIndex = 0;

    for (const match of text.matchAll(WORD_REGEX)) {
      const word = match[0];
      const start = match.index ?? 0;
      const end = start + word.length;

      if (overlapsIgnoredRange(start, end, ignoredRanges)) {
        continue;
      }

      tokens.push({
        from: pos + start,
        to: pos + end,
        word
      });
    }
  });

  return tokens;
}