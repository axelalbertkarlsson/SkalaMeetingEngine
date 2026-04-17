import type { EditorState, Transaction } from "@milkdown/prose/state";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import {
  getWikiLinkDisplayText,
  parseWikiLinks,
  resolveDocumentLinkTarget
} from "../documentsLinks";
import type { DocumentsIndex } from "../../models/documents";

export interface EditorWikiLinkRange {
  from: number;
  to: number;
  targetPath: string;
  alias: string | null;
  heading: string | null;
  targetNoteId: string | null;
  isDangling: boolean;
  displayText: string;
}

interface WikiLinkPluginState {
  decorations: DecorationSet;
  links: EditorWikiLinkRange[];
}

interface WikiLinkPluginMeta {
  links: EditorWikiLinkRange[];
}

export const wikiLinkPluginKey = new PluginKey<WikiLinkPluginState>("documents-wiki-links");

function createDecorations(doc: EditorState["doc"], links: EditorWikiLinkRange[]) {
  return DecorationSet.create(
    doc,
    links.map((link) =>
      Decoration.inline(link.from, link.to, {
        class: link.isDangling ? "documents-wiki-link dangling" : "documents-wiki-link",
        "data-doc-link-target": link.targetPath,
        "data-doc-link-note-id": link.targetNoteId ?? "",
        "data-doc-link-display": link.displayText
      })
    )
  );
}

function mapRanges(transaction: Transaction, links: EditorWikiLinkRange[]) {
  return links.flatMap((link) => {
    const from = transaction.mapping.map(link.from, -1);
    const to = transaction.mapping.map(link.to, 1);

    if (from >= to) {
      return [];
    }

    return [
      {
        ...link,
        from,
        to
      }
    ];
  });
}

export function createWikiLinkPlugin() {
  return new Plugin<WikiLinkPluginState>({
    key: wikiLinkPluginKey,
    state: {
      init() {
        return {
          decorations: DecorationSet.empty,
          links: []
        };
      },
      apply(transaction, previous) {
        const meta = transaction.getMeta(wikiLinkPluginKey) as WikiLinkPluginMeta | undefined;

        if (meta) {
          return {
            links: meta.links,
            decorations: createDecorations(transaction.doc, meta.links)
          };
        }

        if (!transaction.docChanged) {
          return previous;
        }

        const links = mapRanges(transaction, previous.links);
        return {
          links,
          decorations: createDecorations(transaction.doc, links)
        };
      }
    },
    props: {
      decorations(state) {
        return wikiLinkPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
      }
    }
  });
}

export function collectEditorWikiLinks(doc: EditorState["doc"], documentsIndex: DocumentsIndex) {
  const links: EditorWikiLinkRange[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return;
    }

    const parsedLinks = parseWikiLinks(node.text);
    parsedLinks.forEach((parsedLink) => {
      const resolution = resolveDocumentLinkTarget(parsedLink.targetPath, documentsIndex);
      links.push({
        from: pos + parsedLink.from,
        to: pos + parsedLink.to,
        targetPath: parsedLink.targetPath,
        alias: parsedLink.alias,
        heading: parsedLink.heading,
        targetNoteId: resolution.note?.id ?? null,
        isDangling: resolution.note == null,
        displayText: getWikiLinkDisplayText(parsedLink)
      });
    });
  });

  return links;
}

export function updateWikiLinkDecorations(view: EditorView, links: EditorWikiLinkRange[]) {
  const transaction = view.state.tr
    .setMeta(wikiLinkPluginKey, { links } satisfies WikiLinkPluginMeta)
    .setMeta("addToHistory", false);
  view.dispatch(transaction);
}

export function clearWikiLinkDecorations(view: EditorView) {
  updateWikiLinkDecorations(view, []);
}

export function getWikiLinkAtPos(state: EditorState, pos: number) {
  const pluginState = wikiLinkPluginKey.getState(state);
  if (!pluginState) {
    return null;
  }

  return (
    pluginState.links.find((link) => pos >= link.from && pos < link.to) ??
    pluginState.links.find((link) => pos > link.from && pos <= link.to) ??
    null
  );
}
