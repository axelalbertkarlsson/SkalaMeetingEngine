import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MilkdownEditor } from "../components/shell/MilkdownEditor";
import { PanelLeftIcon, PanelRightIcon } from "../components/shell/icons";
import { useLocalStorageState } from "../hooks/useLocalStorageState";

type ThemeMode = "dark" | "light";

interface DocumentsScreenProps {
  theme: ThemeMode;
}

const defaultDocument = `# Meeting Working Document

Use this page as a first-class markdown workspace for synthesis and publish prep.

## Quick outline

- [ ] Capture key decisions
- [ ] Confirm owners and deadlines
- [ ] Prepare publish-ready summary

## Links

- [Project board](https://example.com)
- [Design notes](https://example.com)

## Action items

| Owner | Task | Due |
| --- | --- | --- |
| Alex | Validate notes | 2026-03-15 |
| Sam | Publish to vault | 2026-03-18 |

> Keep claims conservative unless supported by transcript evidence.

\`\`\`bash
# Example snippet
codex --workspace .
\`\`\`
`;

export function DocumentsScreen({ theme }: DocumentsScreenProps) {
  const [markdown, setMarkdown] = useLocalStorageState<string>("documents.markdown", defaultDocument);
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

  return (
    <section className="workspace-screen documents-screen">
      <div className="documents-toolbar">{togglePreviewButton}</div>

      <article
        className={`pane-block documents-pane documents-split-pane${previewCollapsed ? " preview-collapsed" : ""}`}
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
