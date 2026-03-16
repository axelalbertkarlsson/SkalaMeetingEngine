interface RenameDialogProps {
  title: string;
  value: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RenameDialog({
  title,
  value,
  confirmLabel = "Rename",
  cancelLabel = "Cancel",
  onValueChange,
  onConfirm,
  onCancel
}: RenameDialogProps) {
  return (
    <div className="confirm-dialog-overlay" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="confirm-dialog-header">
          <h2 className="confirm-dialog-title">{title}</h2>
          <button
            type="button"
            className="confirm-dialog-close"
            aria-label="Close"
            title="Close"
            onClick={onCancel}
          >
            x
          </button>
        </header>

        <form
          className="confirm-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <label className="rename-dialog-field">
            <span className="rename-dialog-label">New name</span>
            <input
              autoFocus
              className="rename-dialog-input"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
            />
          </label>

          <footer className="confirm-dialog-actions">
            <button type="button" className="confirm-dialog-button" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button type="submit" className="confirm-dialog-button primary">
              {confirmLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
