import { useEffect, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MilkdownEditor } from "../components/shell/MilkdownEditor";
import { PanelLeftIcon, PanelRightIcon } from "../components/shell/icons";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import {
  isDocumentsFilePersistenceAvailable,
  readDocumentNoteFile,
  writeDocumentNoteFile
} from "../services/documentsFileStore";

type ThemeMode = "dark" | "light";
type DocumentsEditorFont = "ibm-plex-sans" | "switzer";

interface DocumentsScreenProps {
  theme: ThemeMode;
  noteId?: string;
  documentsBasePath: string;
  editorFont: DocumentsEditorFont;
}

function getDocumentMarkdownStorageKey(noteId?: string) {
  return noteId ? `documents.markdown.${noteId}` : "documents.markdown.unbound";
}

function readDocumentMarkdownFromLocalStorage(noteId: string) {
  const raw = window.localStorage.getItem(getDocumentMarkdownStorageKey(noteId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

function writeDocumentMarkdownToLocalStorage(noteId: string, markdown: string) {
  window.localStorage.setItem(getDocumentMarkdownStorageKey(noteId), JSON.stringify(markdown));
}

export function DocumentsScreen({ theme, noteId, documentsBasePath, editorFont }: DocumentsScreenProps) {
  const [markdown, setMarkdown] = useState("");
  const [markdownReady, setMarkdownReady] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorageState<boolean>(
    "documents.previewCollapsed",
    false
  );
  const filePersistenceAvailable = isDocumentsFilePersistenceAvailable();
  const markdownRef = useRef(markdown);

  markdownRef.current = markdown;

  const editorSurfaceStyle = {
    "--documents-editor-font-family":
      editorFont === "switzer"
        ? '"Switzer", "IBM Plex Sans", "Segoe UI", sans-serif'
        : '"IBM Plex Sans", "Segoe UI", sans-serif'
  } as CSSProperties;

  useEffect(() => {
    window.localStorage.removeItem("documents.previewMode");
    window.localStorage.removeItem("documents.editorCollapsed");
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!noteId) {
      setMarkdown("");
      setMarkdownReady(false);
      return () => {
        cancelled = true;
      };
    }

    setMarkdown("");
    setMarkdownReady(false);

    const loadMarkdown = async () => {
      const localMarkdown = readDocumentMarkdownFromLocalStorage(noteId);
      const fileMarkdown = await readDocumentNoteFile(noteId, documentsBasePath);

      if (cancelled) {
        return;
      }

      const resolvedMarkdown = fileMarkdown ?? localMarkdown ?? "";
      setMarkdown(resolvedMarkdown);
      setMarkdownReady(true);
      writeDocumentMarkdownToLocalStorage(noteId, resolvedMarkdown);

      if (fileMarkdown === null && localMarkdown !== null) {
        void writeDocumentNoteFile(noteId, localMarkdown, documentsBasePath);
      }
    };

    void loadMarkdown();

    return () => {
      cancelled = true;
    };
  }, [noteId, documentsBasePath]);

  useEffect(() => {
    if (!noteId || !markdownReady) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      writeDocumentMarkdownToLocalStorage(noteId, markdown);
      void writeDocumentNoteFile(noteId, markdown, documentsBasePath);
    }, 160);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [noteId, markdown, markdownReady, documentsBasePath]);

  useEffect(() => {
    if (!noteId || !markdownReady) {
      return;
    }

    return () => {
      const latestMarkdown = markdownRef.current;
      writeDocumentMarkdownToLocalStorage(noteId, latestMarkdown);
      void writeDocumentNoteFile(noteId, latestMarkdown, documentsBasePath);
    };
  }, [noteId, markdownReady, documentsBasePath]);

  const togglePreviewButton = (
    <button
      type="button"
      className="documents-pane-toggle documents-pane-toggle-chevron"
      onClick={() => setPreviewCollapsed((current) => !current)}
      aria-pressed={previewCollapsed}
      aria-label={previewCollapsed ? "Show preview panel" : "Hide preview panel"}
      title={previewCollapsed ? "Show preview panel" : "Hide preview panel"}
    >
      <span className="documents-pane-toggle-chevron-glyph" aria-hidden="true">
        {previewCollapsed ? "<" : ">"}
      </span>
    </button>
  );

  if (!noteId) {
    return (
      <section className="workspace-screen documents-screen" style={editorSurfaceStyle}>
        <article className="pane-block">
          <h3 className="block-title">No note selected</h3>
          <p className="muted">Create or select a note in the Documents sidebar to start editing.</p>
        </article>
      </section>
    );
  }

  return (
    <section className="workspace-screen documents-screen" style={editorSurfaceStyle}>
      <div className="documents-toolbar">{togglePreviewButton}</div>
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
          {markdownReady ? (
            <MilkdownEditor
              key={`${noteId ?? "documents"}:${documentsBasePath || "default"}`}
              value={markdown}
              onChange={setMarkdown}
              className="documents-editor-root"
            />
          ) : (
            <p className="muted documents-loading">Loading note...</p>
          )}
        </div>

        <aside className="documents-preview-pane" aria-label="Markdown preview" aria-hidden={previewCollapsed}>
          <div className="documents-preview-scroll">
            <div className="documents-preview-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          </div>
        </aside>
      </article>
    </section>
  );
}

