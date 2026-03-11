import { PaneHeader } from "../components/shell/PaneHeader";
import { useLocalStorageState } from "../hooks/useLocalStorageState";
import MDEditor from "@uiw/react-md-editor";
import remarkGfm from "remark-gfm";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

type DocumentPreviewMode = "live" | "edit" | "preview";
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

const previewModeOptions: Array<{ id: DocumentPreviewMode; label: string }> = [
  { id: "live", label: "Live" },
  { id: "edit", label: "Edit" },
  { id: "preview", label: "Preview" }
];

export function DocumentsScreen({ theme }: DocumentsScreenProps) {
  const [markdown, setMarkdown] = useLocalStorageState<string>("documents.markdown", defaultDocument);
  const [previewMode, setPreviewMode] = useLocalStorageState<DocumentPreviewMode>(
    "documents.previewMode",
    "live"
  );

  return (
    <section className="workspace-screen documents-screen">
      <PaneHeader
        eyebrow="Documents"
        title="Markdown Workspace"
        subtitle="Write and review markdown with editor + rendered preview inside the main workspace pane."
        actions={
          <div className="documents-mode-toggle" role="group" aria-label="Markdown view mode">
            {previewModeOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`documents-mode-button${previewMode === option.id ? " active" : ""}`}
                onClick={() => setPreviewMode(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      <article className="pane-block documents-pane" data-color-mode={theme === "dark" ? "dark" : "light"}>
        <MDEditor
          style={{ height: "100%" }}
          value={markdown}
          onChange={(value) => setMarkdown(value ?? "")}
          preview={previewMode}
          visibleDragbar={false}
          previewOptions={{ remarkPlugins: [remarkGfm] }}
          textareaProps={{
            placeholder: "Write markdown here...",
            "aria-label": "Markdown document"
          }}
        />
      </article>
    </section>
  );
}
