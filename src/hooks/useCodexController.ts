import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  appendTextToConversationEntry,
  clearComposerAfterSuccessfulSend,
  createCodexConversationEntryFromItem,
  createCodexEventEntry,
  createCodexQueuedSend,
  upsertCodexContextItem,
  upsertConversationEntry,
  type CodexQueuedSend
} from "../lib/codexContext.js";
import {
  archiveCodexThread,
  connectCodexAppServer,
  listCodexThreads,
  readCodexThread,
  respondToCodexServerRequest,
  resumeCodexThread,
  sendCodexTurn,
  startCodexThread,
  stopCodexAppServer
} from "../lib/codexApi.js";
import {
  createInitialCodexThreadLocalState,
  EMPTY_CODEX_THREAD_LOCAL_STORE,
  extractCodexThreadDetails,
  extractCodexThreadSummary,
  getCodexThreadLocalStoreKey,
  resolveCodexThreadTitle,
  sanitizeCodexThreadLocalStore,
  sortCodexThreads
} from "../lib/codexThreads.js";
import type {
  CodexAppEventPayload,
  CodexContextItem,
  CodexConversationEntry,
  CodexSessionState,
  CodexThreadLocalState,
  CodexThreadLocalStore,
  CodexThreadSummary
} from "../models/codex.js";

const CODEX_APP_EVENT = "codex://app-event";

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

interface DetachedComposerState {
  draft: string;
  contextItems: CodexContextItem[];
  lastSubmittedPrompt: string | null;
}

interface UseCodexControllerOptions {
  workspaceRoot: string;
  commandPath: string;
  captureDebugBundle: boolean;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createInitialSessionState(): CodexSessionState {
  return {
    connectionId: null,
    activeThreadId: null,
    activeTurnId: null,
    status: "idle",
    message: "Ready",
    lastEventMethod: null
  };
}

function createDetachedComposerState(): DetachedComposerState {
  return {
    draft: "",
    contextItems: [],
    lastSubmittedPrompt: null
  };
}

function limitConversationEntries(entries: CodexConversationEntry[]) {
  return entries.slice(-400);
}

function extractTurnId(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const params = payload as Record<string, unknown>;
  const turn = params.turn;
  if (turn && typeof turn === "object" && typeof (turn as { id?: unknown }).id === "string") {
    return (turn as { id: string }).id;
  }

  return null;
}

function extractThreadId(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const params = payload as Record<string, unknown>;
  const thread = params.thread;
  if (thread && typeof thread === "object" && typeof (thread as { id?: unknown }).id === "string") {
    return (thread as { id: string }).id;
  }

  return null;
}

export function useCodexController({
  workspaceRoot,
  commandPath,
  captureDebugBundle: _captureDebugBundle
}: UseCodexControllerOptions) {
  const [session, setSession] = useState<CodexSessionState>(createInitialSessionState);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [conversationEntries, setConversationEntries] = useState<CodexConversationEntry[]>([]);
  const [highlightedContextItemId, setHighlightedContextItemId] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<CodexQueuedSend | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const [pendingUserInputRequest, setPendingUserInputRequest] = useState<PendingUserInputRequest | null>(null);
  const [threadLocalStore, setThreadLocalStore] = useState<CodexThreadLocalStore>(() => {
    if (typeof window === "undefined") {
      return EMPTY_CODEX_THREAD_LOCAL_STORE;
    }

    const raw = window.localStorage.getItem(getCodexThreadLocalStoreKey(workspaceRoot));
    if (!raw) {
      return EMPTY_CODEX_THREAD_LOCAL_STORE;
    }

    try {
      return sanitizeCodexThreadLocalStore(JSON.parse(raw));
    } catch {
      return EMPTY_CODEX_THREAD_LOCAL_STORE;
    }
  });
  const [detachedComposerState, setDetachedComposerState] = useState<DetachedComposerState>(
    createDetachedComposerState
  );

  const sessionRef = useRef(session);
  const connectPromiseRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      getCodexThreadLocalStoreKey(workspaceRoot),
      JSON.stringify(threadLocalStore)
    );
  }, [threadLocalStore, workspaceRoot]);

  useEffect(() => {
    setThreads((current) => sortCodexThreads(current, threadLocalStore));
  }, [threadLocalStore]);

  useEffect(() => {
    if (!highlightedContextItemId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setHighlightedContextItemId((current) =>
        current === highlightedContextItemId ? null : current
      );
    }, 1600);

    return () => window.clearTimeout(timeoutId);
  }, [highlightedContextItemId]);

  const activeThreadLocalState = useMemo(() => {
    if (!session.activeThreadId) {
      return null;
    }

    return threadLocalStore.threads[session.activeThreadId] ?? createInitialCodexThreadLocalState();
  }, [session.activeThreadId, threadLocalStore.threads]);

  const draft = activeThreadLocalState?.draft ?? detachedComposerState.draft;
  const contextItems = activeThreadLocalState?.contextItems ?? detachedComposerState.contextItems;
  const lastSubmittedPrompt =
    activeThreadLocalState?.lastSubmittedPrompt ?? detachedComposerState.lastSubmittedPrompt;
  const canSend = Boolean(createCodexQueuedSend(draft, contextItems));

  const appendConversationEntry = useCallback((entry: CodexConversationEntry) => {
    setConversationEntries((current) => limitConversationEntries([...current, entry]));
  }, []);

  const requestComposerFocus = useCallback(() => {
    setComposerFocusSignal((current) => current + 1);
  }, []);

  const upsertThreadLocalState = useCallback(
    (threadId: string, updater: (current: CodexThreadLocalState) => CodexThreadLocalState) => {
      setThreadLocalStore((current) => ({
        ...current,
        threads: {
          ...current.threads,
          [threadId]: updater(current.threads[threadId] ?? createInitialCodexThreadLocalState())
        }
      }));
    },
    []
  );

  const updateCurrentComposerState = useCallback(
    (updater: (current: DetachedComposerState | CodexThreadLocalState) => DetachedComposerState | CodexThreadLocalState) => {
      const activeThreadId = sessionRef.current.activeThreadId;
      if (!activeThreadId) {
        setDetachedComposerState((current) => updater(current) as DetachedComposerState);
        return;
      }

      upsertThreadLocalState(activeThreadId, (current) => updater(current) as CodexThreadLocalState);
    },
    [upsertThreadLocalState]
  );

  const setDraft = useCallback(
    (value: string) => {
      updateCurrentComposerState((current) => ({
        ...current,
        draft: value
      }));
    },
    [updateCurrentComposerState]
  );

  const refreshThreads = useCallback(
    async (connectionId = sessionRef.current.connectionId) => {
      if (!connectionId) {
        setThreads([]);
        return [];
      }

      setThreadsLoading(true);

      try {
        const rawThreads = await listCodexThreads({
          connectionId,
          cwd: workspaceRoot
        });
        const summaries = rawThreads
          .map((thread) => extractCodexThreadSummary(thread))
          .filter((thread): thread is CodexThreadSummary => thread !== null)
          .filter((thread) => !thread.archived);
        const nextThreads = sortCodexThreads(
          summaries.map((thread) => ({
            ...thread,
            name: resolveCodexThreadTitle(thread, threadLocalStore.threads[thread.id])
          })),
          threadLocalStore
        );
        setThreads(nextThreads);
        return nextThreads;
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry(
            "Codex history error",
            `Failed to load Codex history: ${String(error)}`
          )
        );
        return [];
      } finally {
        setThreadsLoading(false);
      }
    },
    [appendConversationEntry, threadLocalStore, workspaceRoot]
  );

  const activateThreadFromRaw = useCallback(
    (rawThread: unknown) => {
      const details = extractCodexThreadDetails(rawThread);
      if (!details) {
        throw new Error("Codex thread response did not include a readable thread.");
      }

      setConversationEntries(details.conversationEntries);
      setSession((current) => ({
        ...current,
        activeThreadId: details.id,
        activeTurnId: null
      }));
      setThreadLocalStore((current) => ({
        ...current,
        lastOpenedThreadId: details.id,
        threads: {
          ...current.threads,
          [details.id]: {
            ...(current.threads[details.id] ?? createInitialCodexThreadLocalState()),
            lastOpenedAt: new Date().toISOString()
          }
        }
      }));
      setHistoryPanelOpen(false);

      return details;
    },
    []
  );

  const selectThread = useCallback(
    async (threadId: string, options?: { connectionId?: string | null; focusComposer?: boolean }) => {
      const connectionId = options?.connectionId ?? sessionRef.current.connectionId;
      if (!connectionId) {
        return false;
      }

      try {
        const rawThread = await readCodexThread({
          connectionId,
          threadId
        });
        await resumeCodexThread({
          connectionId,
          threadId
        });
        activateThreadFromRaw(rawThread);
        if (options?.focusComposer !== false) {
          requestComposerFocus();
        }
        return true;
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry(
            "Codex thread error",
            `Failed to open Codex thread: ${String(error)}`
          )
        );
        return false;
      }
    },
    [activateThreadFromRaw, appendConversationEntry, requestComposerFocus]
  );

  const startSession = useCallback(
    async (reason: "manual" | "send" = "manual") => {
      if (sessionRef.current.connectionId && sessionRef.current.status === "running") {
        return sessionRef.current.connectionId;
      }

      if (connectPromiseRef.current) {
        return connectPromiseRef.current;
      }

      const resolvedCommand = commandPath.trim() || "codex";

      setPendingUserInputRequest(null);
      setSession((current) => ({
        ...current,
        connectionId: null,
        activeTurnId: null,
        status: "starting",
        message: "Connecting to Codex app-server...",
        lastEventMethod: null
      }));

      if (!isTauriRuntime()) {
        setSession((current) => ({
          ...current,
          status: "error",
          message: "Tauri runtime unavailable (web dev mode)."
        }));
        return null;
      }

      const promise = (async () => {
        try {
          const response = await connectCodexAppServer({
            workspacePath: workspaceRoot,
            command: resolvedCommand
          });

          setSession((current) => ({
            ...current,
            connectionId: response.connectionId,
            activeTurnId: null,
            status: "running",
            message: response.message,
            lastEventMethod: null
          }));

          const nextThreads = await refreshThreads(response.connectionId);
          const preferredThreadId =
            sessionRef.current.activeThreadId
            ?? (reason === "manual" ? threadLocalStore.lastOpenedThreadId : null);

          if (
            preferredThreadId
            && nextThreads.some((thread) => thread.id === preferredThreadId)
          ) {
            await selectThread(preferredThreadId, {
              connectionId: response.connectionId,
              focusComposer: false
            });
          }

          return response.connectionId;
        } catch (error) {
          const message = `Failed to connect to Codex app-server: ${String(error)}`;
          setSession((current) => ({
            ...current,
            connectionId: null,
            status: "error",
            message
          }));
          appendConversationEntry(createCodexEventEntry("Codex connection error", message));
          return null;
        } finally {
          connectPromiseRef.current = null;
        }
      })();

      connectPromiseRef.current = promise;
      return promise;
    },
    [appendConversationEntry, commandPath, refreshThreads, selectThread, threadLocalStore.lastOpenedThreadId, workspaceRoot]
  );

  const stopSession = useCallback(() => {
    void (async () => {
      const connectionId = sessionRef.current.connectionId;
      if (!connectionId) {
        return;
      }

      setSession((current) => ({
        ...current,
        status: "stopping",
        message: "Stopping Codex app-server..."
      }));

      try {
        const message = await stopCodexAppServer(connectionId);
        appendConversationEntry(createCodexEventEntry("Codex stopped", message));
      } catch (error) {
        const message = `Failed to stop Codex app-server: ${String(error)}`;
        setSession((current) => ({
          ...current,
          status: "error",
          message
        }));
        appendConversationEntry(createCodexEventEntry("Codex stop error", message));
      }
    })();
  }, [appendConversationEntry]);

  const startNewChat = useCallback(() => {
    void (async () => {
      requestComposerFocus();
      setPendingSend(null);
      setPendingUserInputRequest(null);
      setHighlightedContextItemId(null);

      const connectionId = await startSession("manual");
      if (!connectionId) {
        return;
      }

      try {
        const rawThread = await startCodexThread({
          connectionId,
          workspacePath: workspaceRoot
        });
        activateThreadFromRaw(rawThread);
        await refreshThreads(connectionId);
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry(
            "Codex thread error",
            `Failed to start a new Codex chat: ${String(error)}`
          )
        );
      }
    })();
  }, [activateThreadFromRaw, appendConversationEntry, refreshThreads, requestComposerFocus, startSession, workspaceRoot]);

  const dispatchSend = useCallback(
    async (send: CodexQueuedSend, connectionId: string, expectedTurnId?: string | null) => {
      try {
        await sendCodexTurn({
          connectionId,
          prompt: send.prompt,
          expectedTurnId
        });
        return true;
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry("Codex send error", `Failed to send prompt: ${String(error)}`)
        );
        return false;
      }
    },
    [appendConversationEntry]
  );

  const sendDraft = useCallback(() => {
    void (async () => {
      const send = createCodexQueuedSend(draft, contextItems);
      if (!send) {
        return;
      }

      setPendingSend(send);

      const connectionId = await startSession("send");
      if (!connectionId) {
        setPendingSend(null);
        return;
      }

      let activeThreadId = sessionRef.current.activeThreadId;

      if (!activeThreadId) {
        try {
          const rawThread = await startCodexThread({
            connectionId,
            workspacePath: workspaceRoot
          });
          const details = activateThreadFromRaw(rawThread);
          activeThreadId = details.id;
          await refreshThreads(connectionId);
        } catch (error) {
          appendConversationEntry(
            createCodexEventEntry(
              "Codex thread error",
              `Failed to start a new Codex chat: ${String(error)}`
            )
          );
          setPendingSend(null);
          return;
        }
      }

      const sent = await dispatchSend(send, connectionId, sessionRef.current.activeTurnId);
      setPendingSend(null);
      if (!sent || !activeThreadId) {
        return;
      }

      const clearedComposer = clearComposerAfterSuccessfulSend();
      upsertThreadLocalState(activeThreadId, (current) => ({
        ...current,
        draft: clearedComposer.draft,
        contextItems: clearedComposer.contextItems,
        lastOpenedAt: new Date().toISOString(),
        lastSubmittedPrompt:
          send.draft.trim() || send.contextItems[0]?.label || "Context turn"
      }));
      setHighlightedContextItemId(null);
      await refreshThreads(connectionId);
    })();
  }, [activateThreadFromRaw, appendConversationEntry, contextItems, dispatchSend, draft, refreshThreads, startSession, upsertThreadLocalState, workspaceRoot]);

  const submitUserInputRequest = useCallback(
    async (answers: Record<string, string[]>) => {
      const request = pendingUserInputRequest;
      const connectionId = sessionRef.current.connectionId;
      if (!request || !connectionId) {
        return;
      }

      try {
        await respondToCodexServerRequest({
          connectionId,
          requestId: request.requestId,
          result: {
            answers: Object.fromEntries(
              Object.entries(answers).map(([questionId, questionAnswers]) => [
                questionId,
                { answers: questionAnswers }
              ])
            )
          }
        });
        setPendingUserInputRequest(null);
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry(
            "Codex request error",
            `Failed to answer request_user_input: ${String(error)}`
          )
        );
      }
    },
    [appendConversationEntry, pendingUserInputRequest]
  );

  const clearConversation = useCallback(() => {
    setConversationEntries([]);
  }, []);

  const addContextItem = useCallback((item: CodexContextItem) => {
    updateCurrentComposerState((current) => {
      const result = upsertCodexContextItem(current.contextItems, item);
      setHighlightedContextItemId(result.highlightedItemId);
      return {
        ...current,
        contextItems: result.items
      };
    });
    requestComposerFocus();
  }, [requestComposerFocus, updateCurrentComposerState]);

  const removeContextItem = useCallback((itemId: string) => {
    updateCurrentComposerState((current) => ({
      ...current,
      contextItems: current.contextItems.filter((item) => item.id !== itemId)
    }));
    setHighlightedContextItemId((current) => (current === itemId ? null : current));
  }, [updateCurrentComposerState]);

  const clearContextItems = useCallback(() => {
    updateCurrentComposerState((current) => ({
      ...current,
      contextItems: []
    }));
    setHighlightedContextItemId(null);
  }, [updateCurrentComposerState]);

  const renameThread = useCallback((threadId: string, title: string) => {
    upsertThreadLocalState(threadId, (current) => ({
      ...current,
      customTitle: title.trim() ? title.trim() : null
    }));
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              name: title.trim() || thread.preview || "New Chat"
            }
          : thread
      )
    );
  }, [upsertThreadLocalState]);

  const archiveThreadById = useCallback((threadId: string) => {
    void (async () => {
      const connectionId = await startSession("manual");
      if (!connectionId) {
        return;
      }

      try {
        await archiveCodexThread({
          connectionId,
          threadId
        });
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
        setThreadLocalStore((current) => {
          const nextThreads = { ...current.threads };
          delete nextThreads[threadId];
          return {
            lastOpenedThreadId:
              current.lastOpenedThreadId === threadId ? null : current.lastOpenedThreadId,
            threads: nextThreads
          };
        });

        if (sessionRef.current.activeThreadId === threadId) {
          setSession((current) => ({
            ...current,
            activeThreadId: null,
            activeTurnId: null
          }));
          setConversationEntries([]);
          setDetachedComposerState(createDetachedComposerState());
        }
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry(
            "Codex history error",
            `Failed to archive Codex thread: ${String(error)}`
          )
        );
      }
    })();
  }, [appendConversationEntry, startSession]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    const unlistenFns: UnlistenFn[] = [];

    const attachListener = async () => {
      try {
        const unlisten = await listen<CodexAppEventPayload>(CODEX_APP_EVENT, (event) => {
          const payload = event.payload;
          if (
            sessionRef.current.connectionId
            && payload.connection_id !== sessionRef.current.connectionId
          ) {
            return;
          }

          if (payload.kind === "lifecycle") {
            if (payload.phase === "connected") {
              setSession((current) => ({
                ...current,
                status: "running",
                message: payload.message
              }));
            } else if (payload.phase === "stopped") {
              setSession((current) => ({
                ...current,
                connectionId: null,
                activeTurnId: null,
                status: "stopped",
                message: payload.message
              }));
              setPendingUserInputRequest(null);
            } else {
              setSession((current) => ({
                ...current,
                status: "error",
                message: payload.message
              }));
            }
            return;
          }

          if (payload.kind === "stderr") {
            appendConversationEntry(
              createCodexEventEntry("Codex stderr", payload.text, {
                id: `conversation-stderr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              })
            );
            return;
          }

          if (payload.kind === "server_request") {
            if (
              payload.method === "item/tool/requestUserInput"
              && payload.params
              && typeof payload.params === "object"
            ) {
              const params = payload.params as Record<string, unknown>;
              const questions = Array.isArray(params.questions)
                ? params.questions
                    .filter((question): question is PendingUserInputRequest["questions"][number] =>
                      Boolean(question) && typeof question === "object"
                    )
                    .map((question) => ({
                      header: typeof question.header === "string" ? question.header : "Question",
                      id: typeof question.id === "string" ? question.id : `question-${Date.now()}`,
                      question: typeof question.question === "string" ? question.question : "",
                      options: Array.isArray(question.options)
                        ? question.options
                            .filter((option): option is { label: string; description: string } =>
                              Boolean(option)
                              && typeof option === "object"
                              && typeof option.label === "string"
                              && typeof option.description === "string"
                            )
                        : null
                    }))
                : [];

              setPendingUserInputRequest({
                requestId: payload.request_id,
                itemId: typeof params.itemId === "string" ? params.itemId : "request-user-input",
                turnId: typeof params.turnId === "string" ? params.turnId : "",
                questions
              });
              return;
            }

            appendConversationEntry(
              createCodexEventEntry(
                "Codex request",
                `Received unsupported server request: ${payload.method}`
              )
            );
            return;
          }

          setSession((current) => ({
            ...current,
            lastEventMethod: payload.method
          }));

          if (payload.method === "thread/started") {
            const threadId = extractThreadId(payload.params);
            if (threadId) {
              setSession((current) => ({
                ...current,
                activeThreadId: threadId
              }));
            }
            return;
          }

          if (payload.method === "turn/started") {
            const turnId = extractTurnId(payload.params);
            if (turnId) {
              setSession((current) => ({
                ...current,
                activeTurnId: turnId
              }));
            }
            return;
          }

          if (payload.method === "turn/completed") {
            const turnId = extractTurnId(payload.params);
            setSession((current) => ({
              ...current,
              activeTurnId:
                current.activeTurnId && turnId && current.activeTurnId === turnId
                  ? null
                  : current.activeTurnId
            }));
            setPendingUserInputRequest(null);
            void refreshThreads(sessionRef.current.connectionId);
            return;
          }

          if (payload.method === "error") {
            const params = payload.params as {
              error?: { message?: string };
              willRetry?: boolean;
            } | null;
            const message = params?.error?.message ?? "Codex turn failed.";
            appendConversationEntry(
              createCodexEventEntry(
                params?.willRetry ? "Codex retrying" : "Codex error",
                message
              )
            );
            setSession((current) => ({
              ...current,
              message
            }));
            return;
          }

          if (payload.method === "item/started" || payload.method === "item/completed") {
            if (!payload.params || typeof payload.params !== "object") {
              return;
            }

            const params = payload.params as Record<string, unknown>;
            const turnId = typeof params.turnId === "string" ? params.turnId : "";
            const entry = createCodexConversationEntryFromItem(params.item, turnId);
            if (!entry) {
              return;
            }

            setConversationEntries((current) =>
              limitConversationEntries(upsertConversationEntry(current, entry))
            );
            return;
          }

          if (
            payload.method === "item/agentMessage/delta"
            || payload.method === "item/commandExecution/outputDelta"
            || payload.method === "item/fileChange/outputDelta"
          ) {
            if (!payload.params || typeof payload.params !== "object") {
              return;
            }

            const params = payload.params as Record<string, unknown>;
            const itemId = typeof params.itemId === "string" ? params.itemId : null;
            const delta = typeof params.delta === "string" ? params.delta : "";

            if (!itemId || !delta) {
              return;
            }

            setConversationEntries((current) =>
              limitConversationEntries(appendTextToConversationEntry(current, itemId, delta))
            );
          }
        });

        if (disposed) {
          unlisten();
          return;
        }

        unlistenFns.push(unlisten);
      } catch (error) {
        appendConversationEntry(
          createCodexEventEntry("Codex listener error", String(error))
        );
      }
    };

    void attachListener();

    return () => {
      disposed = true;
      unlistenFns.forEach((unlisten) => {
        unlisten();
      });
    };
  }, [appendConversationEntry, refreshThreads]);

  return {
    session,
    threads,
    threadsLoading,
    historyPanelOpen,
    setHistoryPanelOpen,
    toggleHistoryPanel: () => setHistoryPanelOpen((current) => !current),
    conversationEntries,
    draft,
    setDraft,
    contextItems,
    highlightedContextItemId,
    pendingSend,
    composerFocusSignal,
    pendingUserInputRequest,
    lastSubmittedPrompt,
    canSend,
    requestComposerFocus,
    addContextItem,
    removeContextItem,
    clearContextItems,
    clearConversation,
    startNewChat,
    startSession,
    stopSession,
    sendDraft,
    submitUserInputRequest,
    refreshThreads,
    selectThread,
    renameThread,
    archiveThread: archiveThreadById
  };
}
