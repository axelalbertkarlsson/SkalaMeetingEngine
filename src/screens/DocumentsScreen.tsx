import { useMemo, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DocumentsGraphView } from "../components/shell/DocumentsGraphView";
import { MilkdownEditor } from "../components/shell/MilkdownEditor";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import {
  getDocumentBacklinks,
  getDocumentOutgoingLinks,
  replaceResolvedWikiLinks
} from "../lib/documentsLinks";
import type { DocumentLinkReference, DocumentResolvedLink, DocumentsIndex } from "../models/documents";
import { isDocumentsFilePersistenceAvailable } from "../services/documentsFileStore";

type ThemeMode = "dark" | "light";
type DocumentsEditorFont = "ibm-plex-sans" | "switzer";
type DocumentsRightPaneMode = "preview" | "graph";

interface DocumentsScreenProps {
  theme: ThemeMode;
  noteId?: string;
  markdown: string;
  markdownReady: boolean;
  markdownRevision: number;
  documentsBasePath: string;
  editorFont: DocumentsEditorFont;
  documentsIndex: DocumentsIndex;
  onMarkdownChange: (noteId: string, markdown: string) => void;
  onOpenDocumentLink: (noteId: string) => void;
}

function escapeMarkdownLabel(value: string) {
  return value.replace(/[[\]\\]/g, "\\$&");
}

function buildPreviewHref(link: DocumentResolvedLink, index: number) {
  if (link.targetNoteId) {
    return `skala-doc://${encodeURIComponent(link.targetNoteId)}?index=${index}`;
  }

  return `skala-dangling://${encodeURIComponent(link.targetPathKey)}?index=${index}`;
}

function DocumentsLinkSection({
  title,
  emptyLabel,
  items,
  onOpenDocumentLink
}: {
  title: string;
  emptyLabel: string;
  items: Array<
    | {
        id: string;
        label: string;
        openNoteId: string | null;
        link: DocumentResolvedLink;
      }
    | {
        id: string;
        label: string;
        sourceLabel: string;
        openNoteId: string | null;
        link: DocumentResolvedLink;
      }
  >;
  onOpenDocumentLink: (noteId: string) => void;
}) {
  return (
    <section className="documents-link-section">
      <div className="documents-link-section-header">
        <h4>{title}</h4>
        <span>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="muted documents-link-empty">{emptyLabel}</p>
      ) : (
        <ul className="documents-link-list">
          {items.map((item) => (
            <li key={item.id} className="documents-link-list-item">
              {"sourceLabel" in item ? (
                <>
                  <span className="documents-link-source">{item.sourceLabel}</span>
                  <span className="documents-link-arrow" aria-hidden="true">
                    →
                  </span>
                </>
              ) : null}
              {item.openNoteId ? (
                <button
                  type="button"
                  className={item.link.targetNoteId ? "documents-link-chip" : "documents-link-chip dangling"}
                  onClick={() => onOpenDocumentLink(item.openNoteId!)}
                >
                  {item.label}
                </button>
              ) : (
                <span className={item.link.targetNoteId ? "documents-link-chip" : "documents-link-chip dangling"}>
                  {item.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DocumentsScreen({
  theme,
  noteId,
  markdown,
  markdownReady,
  markdownRevision,
  documentsBasePath,
  editorFont,
  documentsIndex,
  onMarkdownChange,
  onOpenDocumentLink
}: DocumentsScreenProps) {
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorageState<boolean>(
    "documents.previewCollapsed",
    false
  );
  const [rightPaneMode, setRightPaneMode] = useLocalStorageState<DocumentsRightPaneMode>(
    "documents.rightPaneMode",
    "preview"
  );
  const filePersistenceAvailable = isDocumentsFilePersistenceAvailable();
  const activeNote = noteId ? documentsIndex.notesById[noteId] : undefined;
  const outgoingLinks = useMemo(() => getDocumentOutgoingLinks(noteId, documentsIndex), [documentsIndex, noteId]);
  const backlinks = useMemo(() => getDocumentBacklinks(noteId, documentsIndex), [documentsIndex, noteId]);
  const graphLayoutStorageKey = useMemo(
    () => `documents.graphLayout.${encodeURIComponent(documentsBasePath || "default")}`,
    [documentsBasePath]
  );

  const editorSurfaceStyle = {
    "--documents-editor-font-family":
      editorFont === "switzer"
        ? '"Switzer", "IBM Plex Sans", "Segoe UI", sans-serif'
        : '"IBM Plex Sans", "Segoe UI", sans-serif'
  } as CSSProperties;

  const previewModel = useMemo(() => {
    const hrefMap = new Map<string, DocumentResolvedLink>();
    if (!activeNote || !noteId) {
      return {
        hrefMap,
        markdown: markdown
      };
    }

    let linkIndex = 0;
    const previewMarkdown = replaceResolvedWikiLinks(markdown, activeNote, documentsIndex, (link) => {
      const href = buildPreviewHref(link, linkIndex);
      hrefMap.set(href, link);
      linkIndex += 1;

      return `[${escapeMarkdownLabel(link.displayText)}](${href})`;
    });

    return {
      hrefMap,
      markdown: previewMarkdown
    };
  }, [activeNote, documentsIndex, markdown, noteId]);

  const backlinksItems = useMemo(
    () =>
      backlinks.map((reference: DocumentLinkReference) => ({
        id: `${reference.noteId}:${reference.link.from}`,
        label: reference.link.displayText,
        sourceLabel: reference.noteLabel,
        openNoteId: reference.noteId,
        link: reference.link
      })),
    [backlinks]
  );
  const outgoingItems = useMemo(
    () =>
      outgoingLinks.map((link) => ({
        id: `${link.sourceNoteId}:${link.from}`,
        label: link.displayText,
        openNoteId: link.targetNoteId,
        link
      })),
    [outgoingLinks]
  );

  const togglePreviewButton = (
    <button
      type="button"
      className="documents-pane-toggle documents-pane-toggle-chevron"
      onClick={() => setPreviewCollapsed((current) => !current)}
      aria-pressed={previewCollapsed}
      aria-label={previewCollapsed ? "Show right pane" : "Hide right pane"}
      title={previewCollapsed ? "Show right pane" : "Hide right pane"}
    >
      <span className="documents-pane-toggle-chevron-glyph" aria-hidden="true">
        {previewCollapsed ? "<" : ">"}
      </span>
    </button>
  );

  return (
    <section className="workspace-screen documents-screen" style={editorSurfaceStyle}>
      <div className="documents-toolbar">
        <div className="documents-pane-mode-toggle" role="tablist" aria-label="Documents right pane mode">
          <button
            type="button"
            className={rightPaneMode === "preview" ? "documents-pane-mode-button active" : "documents-pane-mode-button"}
            onClick={() => setRightPaneMode("preview")}
            aria-pressed={rightPaneMode === "preview"}
          >
            Preview
          </button>
          <button
            type="button"
            className={rightPaneMode === "graph" ? "documents-pane-mode-button active" : "documents-pane-mode-button"}
            onClick={() => setRightPaneMode("graph")}
            aria-pressed={rightPaneMode === "graph"}
          >
            Graph
          </button>
        </div>
        {togglePreviewButton}
      </div>

      {!filePersistenceAvailable ? (
        <p className="muted documents-runtime-warning">
          File save path is only used in the Tauri desktop app. In browser localhost mode, notes are kept in local storage.
        </p>
      ) : null}

      <article
        className={`documents-pane documents-split-pane${previewCollapsed ? " preview-collapsed" : ""}`}
        data-theme-mode={theme}
      >
        <div className="documents-editor-pane">
          {noteId ? (
            markdownReady ? (
              <MilkdownEditor
                key={`${noteId}:${documentsBasePath || "default"}:${markdownRevision}`}
                value={markdown}
                onChange={(nextMarkdown) => onMarkdownChange(noteId, nextMarkdown)}
                className="documents-editor-root"
                documentsIndex={documentsIndex}
                onOpenDocumentLink={onOpenDocumentLink}
              />
            ) : (
              <p className="muted documents-loading">Loading note...</p>
            )
          ) : (
            <div className="documents-empty-state">
              <article className="pane-block">
                <h3 className="block-title">No note selected</h3>
                <p className="muted">Create or select a note in the Documents sidebar to start editing.</p>
              </article>
            </div>
          )}
        </div>

        <aside
          className="documents-preview-pane"
          aria-label={rightPaneMode === "graph" ? "Documents graph" : "Markdown preview"}
          aria-hidden={previewCollapsed}
        >
          {rightPaneMode === "graph" ? (
            <DocumentsGraphView
              key={graphLayoutStorageKey}
              activeNoteId={noteId}
              documentsIndex={documentsIndex}
              layoutStorageKey={graphLayoutStorageKey}
              onOpenNote={onOpenDocumentLink}
            />
          ) : (
            <div className="documents-preview-scroll">
              {noteId ? (
                <>
                  <div className="documents-link-sections">
                    <DocumentsLinkSection
                      title="Outgoing"
                      emptyLabel="No wiki-links in this note yet."
                      items={outgoingItems}
                      onOpenDocumentLink={onOpenDocumentLink}
                    />
                    <DocumentsLinkSection
                      title="Backlinks"
                      emptyLabel="No other notes link here yet."
                      items={backlinksItems}
                      onOpenDocumentLink={onOpenDocumentLink}
                    />
                  </div>
                  <div className="documents-preview-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => {
                          if (!href) {
                            return <span>{children}</span>;
                          }

                          const link = previewModel.hrefMap.get(href);
                          if (!link) {
                            return (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            );
                          }

                          if (!link.targetNoteId) {
                            return <span className="documents-inline-link dangling">{children}</span>;
                          }

                          return (
                            <button
                              type="button"
                              className="documents-inline-link"
                              onClick={() => onOpenDocumentLink(link.targetNoteId!)}
                            >
                              {children}
                            </button>
                          );
                        }
                      }}
                    >
                      {previewModel.markdown}
                    </ReactMarkdown>
                  </div>
                </>
              ) : (
                <div className="documents-empty-state">
                  <article className="pane-block">
                    <h3 className="block-title">Preview</h3>
                    <p className="muted">Select a note to inspect backlinks and rendered wiki-links.</p>
                  </article>
                </div>
              )}
            </div>
          )}
        </aside>
      </article>
    </section>
  );
}
