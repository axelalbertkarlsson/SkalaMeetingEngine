import type { EditorState, Transaction } from "@milkdown/prose/state";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { SpellcheckRange } from "../../models/spellcheck";

interface SpellcheckPluginState {
  decorations: DecorationSet;
  ranges: SpellcheckRange[];
}

interface SpellcheckPluginMeta {
  ranges: SpellcheckRange[];
}

export const spellcheckPluginKey = new PluginKey<SpellcheckPluginState>("documents-spellcheck");

function createDecorations(doc: EditorState["doc"], ranges: SpellcheckRange[]) {
  return DecorationSet.create(
    doc,
    ranges.map((range) =>
      Decoration.inline(range.from, range.to, {
        class: "spellcheck-error",
        "data-spellcheck-word": range.word
      })
    )
  );
}

function mapRanges(transaction: Transaction, ranges: SpellcheckRange[]) {
  return ranges.flatMap((range) => {
    const from = transaction.mapping.map(range.from, -1);
    const to = transaction.mapping.map(range.to, 1);

    if (from >= to) {
      return [];
    }

    return [
      {
        ...range,
        from,
        to
      }
    ];
  });
}

export function createSpellcheckPlugin() {
  return new Plugin<SpellcheckPluginState>({
    key: spellcheckPluginKey,
    state: {
      init() {
        return {
          decorations: DecorationSet.empty,
          ranges: []
        };
      },
      apply(transaction, previous) {
        const meta = transaction.getMeta(spellcheckPluginKey) as SpellcheckPluginMeta | undefined;

        if (meta) {
          return {
            ranges: meta.ranges,
            decorations: createDecorations(transaction.doc, meta.ranges)
          };
        }

        if (!transaction.docChanged) {
          return previous;
        }

        const ranges = mapRanges(transaction, previous.ranges);
        return {
          ranges,
          decorations: createDecorations(transaction.doc, ranges)
        };
      }
    },
    props: {
      decorations(state) {
        return spellcheckPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      }
    }
  });
}

export function updateSpellcheckDecorations(view: EditorView, ranges: SpellcheckRange[]) {
  const transaction = view.state.tr
    .setMeta(spellcheckPluginKey, { ranges } satisfies SpellcheckPluginMeta)
    .setMeta("addToHistory", false);
  view.dispatch(transaction);
}

export function clearSpellcheckDecorations(view: EditorView) {
  updateSpellcheckDecorations(view, []);
}

export function getSpellcheckRangeAtPos(state: EditorState, pos: number) {
  const pluginState = spellcheckPluginKey.getState(state);
  if (!pluginState) {
    return null;
  }

  return (
    pluginState.ranges.find((range) => pos >= range.from && pos < range.to) ??
    pluginState.ranges.find((range) => pos > range.from && pos <= range.to) ??
    null
  );
}