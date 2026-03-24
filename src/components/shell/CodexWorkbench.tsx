import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexContextItem,
  CodexConversationEntry,
  CodexSessionState
} from "../../models/codex.js";

interface PendingUserInputRequest {
  requestId: string | number | null;
  itemId: string;
  turnId: string;
  questions: Array<{
    header: string;
    id: string;
    question: string;
    options?: Array<{
      label: string;
      description: string;
    }> | null;
  }>;
}

interface CodexWorkbenchProps {
  variant: "dock" | "page";
  workspacePath: string;
  session: CodexSessionState;
  draft: string;
  contextItems: CodexContextItem[];
  conversationEntries: CodexConversationEntry[];
  highlightedContextItemId: string | null;
  pendingSendId: string | null;
  composerFocusSignal: number;
  canSend: boolean;
  pendingUserInputRequest: PendingUserInputRequest | null;
  lastSubmittedPrompt: string | null;
  onDraftChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
  onSend: () => void;
  onClearConversation: () => void;
  onClearContextItems: () => void;
  onRemoveContextItem: (itemId: string) => void;
  onSubmitUserInputRequest: (answers: Record<string, string[]>) => void;
  onNewChat: () => void;
  onOpenPage?: () => void;
}

function getStatusTone(status: CodexSessionState["status"]) {
  if (status === "running") {
    return "tone-success";
  }

  if (status === "error") {
    return "tone-danger";
  }

  if (status === "starting" || status === "stopping") {
    return "tone-warning";
  }

  return "tone-neutral";
}

function getSendLabel(session: CodexSessionState, pendingSendId: string | null) {
  if (pendingSendId || session.status === "starting") {
    return "Queued";
  }

  if (session.activeTurnId) {
    return "Steer";
  }

  if (session.status === "running") {
    return "Send";
  }

  return "Send";
}

function getEntryClassName(entry: CodexConversationEntry) {
  if (entry.kind === "user_message") {
    return "codex-feed-entry codex-feed-entry-user";
  }

  if (entry.kind === "agent_message") {
    return "codex-feed-entry codex-feed-entry-agent";
  }

  if (entry.kind === "command_execution") {
    return "codex-feed-entry codex-feed-entry-command";
  }

  if (entry.kind === "file_change") {
    return "codex-feed-entry codex-feed-entry-file-change";
  }

  return "codex-feed-entry codex-feed-entry-event";
}

function truncateSingleLineText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized;
}

export function CodexWorkbench({
  variant,
  workspacePath,
  session,
  draft,
  contextItems,
  conversationEntries,
  highlightedContextItemId,
  pendingSendId,
  composerFocusSignal,
  canSend,
  pendingUserInputRequest,
  lastSubmittedPrompt,
  onDraftChange,
  onStart,
  onStop,
  onSend,
  onClearConversation,
  onClearContextItems,
  onRemoveContextItem,
  onSubmitUserInputRequest,
  onNewChat,
  onOpenPage
}: CodexWorkbenchProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const [requestAnswers, setRequestAnswers] = useState<Record<string, string[]>>({});

  useEffect(() => {
    textareaRef.current?.focus();
  }, [composerFocusSignal]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) {
      return;
    }

    feed.scrollTop = feed.scrollHeight;
  }, [conversationEntries, pendingUserInputRequest]);

  useEffect(() => {
    if (!pendingUserInputRequest) {
      setRequestAnswers({});
      return;
    }

    setRequestAnswers((current) => {
      const nextAnswers = { ...current };
      pendingUserInputRequest.questions.forEach((question) => {
        if (nextAnswers[question.id]) {
          return;
        }

        const firstOption = question.options?.[0]?.label;
        nextAnswers[question.id] = firstOption ? [firstOption] : [];
      });
      return nextAnswers;
    });
  }, [pendingUserInputRequest]);

  const canStart = session.status === "idle" || session.status === "stopped" || session.status === "error";
  const canStop = session.status === "running" || session.status === "starting";

  const feedStats = useMemo(() => {
    const agentMessages = conversationEntries.filter((entry) => entry.kind === "agent_message").length;
    const commands = conversationEntries.filter((entry) => entry.kind === "command_execution").length;

    return {
      total: conversationEntries.length,
      agentMessages,
      commands
    };
  }, [conversationEntries]);

  const latestUserPrompt = useMemo(() => {
    const latestEntry = [...conversationEntries]
      .reverse()
      .find((entry) => entry.kind === "user_message" && entry.text.trim().length > 0);

    if (latestEntry) {
      return truncateSingleLineText(latestEntry.text);
    }

    if (lastSubmittedPrompt) {
      return truncateSingleLineText(lastSubmittedPrompt);
    }

    return "";
  }, [conversationEntries, lastSubmittedPrompt]);

  const dockFeedEntries = useMemo(
    () => conversationEntries.filter((entry) => entry.kind !== "user_message"),
    [conversationEntries]
  );

  const hasDockConversation = Boolean(
    latestUserPrompt
      || dockFeedEntries.length
      || pendingSendId
      || session.activeTurnId
      || pendingUserInputRequest
  );

  const renderPendingUserInputRequest = () => {
    if (!pendingUserInputRequest) {
      return null;
    }

    return (
      <section className="codex-user-input-request">
        <header className="codex-workbench-panel-header">
          <strong>Codex needs input</strong>
          <span className="muted">Answer to continue the turn</span>
        </header>
        {pendingUserInputRequest.questions.map((question) => (
          <label key={question.id} className="codex-user-input-question">
            <span className="codex-user-input-question-header">{question.header}</span>
            <span className="muted">{question.question}</span>
            {question.options?.length ? (
              <select
                className="settings-text-input"
                value={requestAnswers[question.id]?.[0] ?? ""}
                onChange={(event) =>
                  setRequestAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value ? [event.target.value] : []
                  }))
                }
              >
                {question.options.map((option) => (
                  <option key={option.label} value={option.label}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="settings-text-input"
                type="text"
                value={requestAnswers[question.id]?.[0] ?? ""}
                onChange={(event) =>
                  setRequestAnswers((current) => ({
                    ...current,
                    [question.id]: event.target.value ? [event.target.value] : []
                  }))
                }
              />
            )}
          </label>
        ))}
        <div className="codex-workbench-composer-actions">
          <p className="muted">These answers are sent back to Codex as a structured response.</p>
          <button
            type="button"
            className="codex-terminal-button"
            onClick={() => onSubmitUserInputRequest(requestAnswers)}
          >
            Submit answers
          </button>
        </div>
      </section>
    );
  };

  const renderContextChips = () => (
    <div className="codex-context-chip-list" aria-label="Codex context items">
      {contextItems.length ? (
        contextItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              item.id === highlightedContextItemId
                ? "codex-context-chip active"
                : "codex-context-chip"
            }
            title={item.path}
            onClick={() => onRemoveContextItem(item.id)}
          >
            <span className="codex-context-chip-label">{item.label}</span>
            <span className="codex-context-chip-meta">
              {item.kind === "document_note" ? "Note" : "Artifact"}
            </span>
            <span className="codex-context-chip-remove" aria-hidden="true">
              x
            </span>
          </button>
        ))
      ) : null}
    </div>
  );

  const renderComposer = (mode: "expanded" | "compact") => (
    <section
      className={
        mode === "expanded"
          ? "codex-cursor-composer-card"
          : "codex-cursor-followup-composer"
      }
    >
      <textarea
        ref={textareaRef}
        className={
          mode === "expanded"
            ? "codex-composer-input codex-composer-input-expanded"
            : "codex-composer-input codex-composer-input-compact"
        }
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="Plan, @ for context, / for commands"
        onKeyDown={(event) => {
          const shouldSendWithEnter =
            variant === "dock"
              ? event.key === "Enter" && !event.shiftKey
              : (event.metaKey || event.ctrlKey) && event.key === "Enter";

          if (shouldSendWithEnter && canSend) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="codex-cursor-composer-footer">
        <div className="codex-cursor-composer-pills">
          {contextItems.length ? (
            <button
              type="button"
              className="codex-cursor-inline-action"
              onClick={onClearContextItems}
            >
              Clear context
            </button>
          ) : null}
        </div>
        <div className="codex-cursor-composer-actions">
          {mode === "compact" ? (
            <button
              type="button"
              className="codex-cursor-inline-action"
              onClick={onClearConversation}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
      {contextItems.length ? renderContextChips() : null}
    </section>
  );

  if (variant === "dock") {
    return (
      <section className="codex-workbench codex-workbench-dock codex-workbench-cursor">
        <div className="codex-cursor-sticky-top">
          <header className="codex-cursor-toolbar">
            <div className="codex-cursor-toolbar-title" title={latestUserPrompt || "New Chat"}>
              {latestUserPrompt || "New Chat"}
            </div>
            <div className="codex-cursor-toolbar-actions">
              <button
                type="button"
                className="codex-cursor-toolbar-button"
                onClick={onNewChat}
                title="New chat"
              >
                +
              </button>
              <button
                type="button"
                className="codex-cursor-toolbar-button"
                onClick={canStop ? onStop : onStart}
                title={canStop ? "Stop Codex" : "Start Codex"}
              >
                {canStop ? "o" : ">"}
              </button>
              <button
                type="button"
                className="codex-cursor-toolbar-button"
                onClick={onClearConversation}
                title="More actions"
              >
                ...
              </button>
            </div>
          </header>

          {hasDockConversation ? (
            <div className="codex-cursor-question-pill" title={latestUserPrompt}>
              {latestUserPrompt || "Waiting for Codex..."}
            </div>
          ) : (
            renderComposer("expanded")
          )}

          <div className="codex-cursor-status-strip">
            <span className={`codex-terminal-status ${getStatusTone(session.status)}`}>
              {session.status.toUpperCase()}
            </span>
            <span className="codex-terminal-message">{session.message}</span>
          </div>
        </div>

        <div className="codex-cursor-feed-shell">
          <div ref={feedRef} className="codex-feed codex-feed-dock" aria-label="Codex conversation">
            {dockFeedEntries.length ? (
              dockFeedEntries.map((entry) => (
                <article key={entry.id} className={getEntryClassName(entry)}>
                  <header className="codex-feed-entry-header">
                    <strong>{entry.title}</strong>
                    {entry.status ? <span className="codex-feed-entry-status">{entry.status}</span> : null}
                  </header>
                  {entry.meta ? <p className="codex-feed-entry-meta">{entry.meta}</p> : null}
                  <pre className="codex-feed-entry-text">{entry.text || " "}</pre>
                </article>
              ))
            ) : (
              <p className="muted codex-feed-empty">
                {pendingUserInputRequest
                  ? "Codex is waiting for your answer below before it can continue."
                  : hasDockConversation
                    ? "Codex output will appear here."
                  : "Start a new chat to stream Codex output into the sidebar."}
              </p>
            )}

            {renderPendingUserInputRequest()}
          </div>
        </div>

        {hasDockConversation ? (
          <div className="codex-cursor-sticky-bottom">
            {renderComposer("compact")}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className={`codex-workbench codex-workbench-${variant}`}>
      <header className="codex-workbench-header">
        <div className="codex-workbench-header-copy">
          <p className="codex-workbench-eyebrow">Codex</p>
          <h3>Workspace session</h3>
          <p className="muted">{workspacePath}</p>
        </div>
        <div className="codex-workbench-header-actions">
          <button
            type="button"
            className="codex-terminal-button secondary"
            onClick={onNewChat}
          >
            New chat
          </button>
          <button
            type="button"
            className="codex-terminal-button secondary"
            onClick={onClearConversation}
          >
            Clear feed
          </button>
          <button
            type="button"
            className="codex-terminal-button"
            disabled={!canStart}
            onClick={onStart}
          >
            Start
          </button>
          <button
            type="button"
            className="codex-terminal-button secondary"
            disabled={!canStop}
            onClick={onStop}
          >
            Stop
          </button>
        </div>
      </header>

      <div className="codex-workbench-status-row">
        <span className={`codex-terminal-status ${getStatusTone(session.status)}`}>
          {session.status.toUpperCase()}
        </span>
        <span className="codex-terminal-message">{session.message}</span>
      </div>

      <div className="codex-workbench-stats">
        <span>{feedStats.total} items</span>
        <span>{feedStats.agentMessages} agent messages</span>
        <span>{feedStats.commands} commands</span>
        <span>{session.threadId ? "Thread ready" : "No thread"}</span>
      </div>

      <section className="codex-workbench-panel codex-feed-panel">
        <div className="codex-workbench-panel-header">
          <strong>Conversation</strong>
          <span className="muted">
            {session.activeTurnId ? "Turn in progress" : "Idle"}
          </span>
        </div>
        <div ref={feedRef} className="codex-feed" aria-label="Codex conversation">
          {conversationEntries.length ? (
            conversationEntries.map((entry) => (
              <article key={entry.id} className={getEntryClassName(entry)}>
                <header className="codex-feed-entry-header">
                  <strong>{entry.title}</strong>
                  {entry.status ? <span className="codex-feed-entry-status">{entry.status}</span> : null}
                </header>
                {entry.meta ? <p className="codex-feed-entry-meta">{entry.meta}</p> : null}
                <pre className="codex-feed-entry-text">{entry.text || " "}</pre>
              </article>
            ))
          ) : (
            <p className="muted codex-feed-empty">
              Start a Codex session to stream structured items here.
            </p>
          )}

          {renderPendingUserInputRequest()}
        </div>
      </section>

      <section className="codex-workbench-panel">
        <div className="codex-workbench-panel-header">
          <strong>Context</strong>
          <button
            type="button"
            className="codex-terminal-button secondary"
            onClick={onClearContextItems}
            disabled={contextItems.length === 0}
          >
            Clear chips
          </button>
        </div>
        {contextItems.length ? renderContextChips() : (
          <p className="muted codex-context-empty">
            Add notes or transcripts from the sidebar or meeting views to stage them for the next turn.
          </p>
        )}
      </section>

      <section className="codex-workbench-panel">
        <div className="codex-workbench-panel-header">
          <strong>Composer</strong>
          <span className="muted">Cmd/Ctrl+Enter to send</span>
        </div>
        <textarea
          ref={textareaRef}
          className="codex-composer-input"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Ask Codex to review, summarize, or transform the staged files."
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSend) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="codex-workbench-composer-actions">
          <p className="muted">
            {pendingSendId
              ? "Prompt is queued and will send as soon as Codex app-server is ready."
              : session.activeTurnId
                ? "A turn is currently running. Sending now will steer the active turn."
                : "File chips are sent as explicit paths, then cleared after a successful turn."}
          </p>
          <button
            type="button"
            className="codex-terminal-button"
            disabled={!canSend}
            onClick={onSend}
          >
            {getSendLabel(session, pendingSendId)}
          </button>
        </div>
      </section>
    </section>
  );
}
