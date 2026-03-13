interface ConfirmDialogProps {
  title: string;
  message: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
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

        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message">{message}</p>
          {description ? <p className="confirm-dialog-description">{description}</p> : null}
        </div>

        <footer className="confirm-dialog-actions">
          <button type="button" className="confirm-dialog-button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "confirm-dialog-button danger" : "confirm-dialog-button primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
