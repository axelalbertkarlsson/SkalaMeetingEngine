import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MilkdownEditor } from "../components/shell/MilkdownEditor";
import { PanelLeftIcon, PanelRightIcon } from "../components/shell/icons";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

type ThemeMode = "dark" | "light";

interface DocumentsScreenProps {
  theme: ThemeMode;
  noteId?: string;
}

function getDocumentMarkdownStorageKey(noteId?: string) {
  return noteId ? `documents.markdown.${noteId}` : "documents.markdown.unbound";
}

export function DocumentsScreen({ theme, noteId }: DocumentsScreenProps) {
  const [markdown, setMarkdown] = useLocalStorageState<string>(
    getDocumentMarkdownStorageKey(noteId),
    ""
  );
  const [previewCollapsed, setPreviewCollapsed] = useLocalStorageState<boolean>(
    "documents.previewCollapsed",
    false
  );

  useEffect(() => {
    window.localStorage.removeItem("documents.previewMode");
    window.localStorage.removeItem("documents.editorCollapsed");
  }, []);

  const togglePreviewButton = (
    <button
      type="button"
      className="documents-pane-toggle"
      onClick={() => setPreviewCollapsed((current) => !current)}
      aria-pressed={previewCollapsed}
      title={previewCollapsed ? "Show preview panel" : "Hide preview panel"}
    >
      <span className="documents-pane-toggle-icon" aria-hidden="true">
        {previewCollapsed ? <PanelRightIcon /> : <PanelLeftIcon />}
      </span>
      <span>{previewCollapsed ? "Show Preview" : "Hide Preview"}</span>
    </button>
  );

  if (!noteId) {
    return (
      <section className="workspace-screen documents-screen">
        <article className="pane-block">
          <h3 className="block-title">No note selected</h3>
          <p className="muted">Create or select a note in the Documents sidebar to start editing.</p>
        </article>
      </section>
    );
  }

  return (
    <section className="workspace-screen documents-screen">
      <div className="documents-toolbar">{togglePreviewButton}</div>

      <article
        className={`documents-pane documents-split-pane${previewCollapsed ? " preview-collapsed" : ""}`}
        data-theme-mode={theme}
      >
        <div className="documents-editor-pane">
          <MilkdownEditor value={markdown} onChange={setMarkdown} className="documents-editor-root" />
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
