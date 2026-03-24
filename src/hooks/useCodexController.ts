import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  appendTextToConversationEntry,
  buildCodexPrompt,
  clearComposerAfterSuccessfulSend,
  createCodexConversationEntryFromItem,
  createCodexEventEntry,
  planCodexSend,
  upsertCodexContextItem,
  upsertConversationEntry,
  type CodexQueuedSend
} from "../lib/codexContext.js";
import {
  connectCodexAppServer,
  respondToCodexServerRequest,
  sendCodexTurn,
  stopCodexAppServer
} from "../lib/codexApi.js";
import type {
  CodexAppEventPayload,
  CodexContextItem,
  CodexConversationEntry,
  CodexSessionState
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

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createInitialSessionState(): CodexSessionState {
  return {
    connectionId: null,
    threadId: null,
    activeTurnId: null,
    status: "idle",
    message: "Ready",
    lastEventMethod: null
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

interface UseCodexControllerOptions {
  workspaceRoot: string;
  commandPath: string;
  captureDebugBundle: boolean;
}

export function useCodexController({
  workspaceRoot,
  commandPath,
  captureDebugBundle: _captureDebugBundle
}: UseCodexControllerOptions) {
  const [session, setSession] = useState<CodexSessionState>(createInitialSessionState);
  const [conversationEntries, setConversationEntries] = useState<CodexConversationEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [contextItems, setContextItems] = useState<CodexContextItem[]>([]);
  const [highlightedContextItemId, setHighlightedContextItemId] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState<CodexQueuedSend | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const [pendingUserInputRequest, setPendingUserInputRequest] = useState<PendingUserInputRequest | null>(null);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState<string | null>(null);

  const sessionRef = useRef(session);
  const pendingSendRef = useRef<CodexQueuedSend | null>(null);
  const newChatRequestedRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    pendingSendRef.current = pendingSend;
  }, [pendingSend]);

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

  const appendConversationEntry = useCallback((entry: CodexConversationEntry) => {
    setConversationEntries((current) => limitConversationEntries([...current, entry]));
  }, []);

  const requestComposerFocus = useCallback(() => {
    setComposerFocusSignal((current) => current + 1);
  }, []);

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
                message: payload.message,
                threadId: payload.thread_id ?? current.threadId
              }));
            } else if (payload.phase === "stopped") {
              if (newChatRequestedRef.current) {
                newChatRequestedRef.current = false;
                setSession(createInitialSessionState());
              } else {
                setSession((current) => ({
                  ...current,
                  connectionId: null,
                  activeTurnId: null,
                  status: "stopped",
                  message: payload.message,
                  threadId: payload.thread_id ?? current.threadId
                }));
              }
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
                threadId
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
  }, [appendConversationEntry]);

  const startSession = useCallback(
    async (reason: "manual" | "send" = "manual") => {
      if (sessionRef.current.status === "running" || sessionRef.current.status === "starting") {
        return true;
      }

      const resolvedCommand = commandPath.trim() || "codex";

      setConversationEntries([]);
      setPendingUserInputRequest(null);
      setLastSubmittedPrompt(null);
      setSession((current) => ({
        ...current,
        connectionId: null,
        activeTurnId: null,
        status: "starting",
        message: "Connecting to Codex app-server...",
        threadId: null,
        lastEventMethod: null
      }));

      if (!isTauriRuntime()) {
        setSession((current) => ({
          ...current,
          status: "error",
          message: "Tauri runtime unavailable (web dev mode)."
        }));
        if (reason === "send") {
          pendingSendRef.current = null;
          setPendingSend(null);
        }
        return false;
      }

      try {
        const response = await connectCodexAppServer({
          workspacePath: workspaceRoot,
          command: resolvedCommand
        });

        setSession({
          connectionId: response.connectionId,
          threadId: response.threadId,
          activeTurnId: null,
          status: "running",
          message: response.message,
          lastEventMethod: null
        });

        return true;
      } catch (error) {
        const message = `Failed to connect to Codex app-server: ${String(error)}`;
        setSession((current) => ({
          ...current,
          status: "error",
          message
        }));
        appendConversationEntry(createCodexEventEntry("Codex connection error", message));
        if (reason === "send") {
          pendingSendRef.current = null;
          setPendingSend(null);
        }
        return false;
      }
    },
    [appendConversationEntry, commandPath, workspaceRoot]
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

  const clearConversation = useCallback(() => {
    setConversationEntries([]);
  }, []);

  const addContextItem = useCallback((item: CodexContextItem) => {
    setContextItems((current) => {
      const result = upsertCodexContextItem(current, item);
      setHighlightedContextItemId(result.highlightedItemId);
      return result.items;
    });
    requestComposerFocus();
  }, [requestComposerFocus]);

  const removeContextItem = useCallback((itemId: string) => {
    setContextItems((current) => current.filter((item) => item.id !== itemId));
    setHighlightedContextItemId((current) => (current === itemId ? null : current));
  }, []);

  const clearContextItems = useCallback(() => {
    setContextItems([]);
    setHighlightedContextItemId(null);
  }, []);

  const dispatchSend = useCallback(
    async (
      send: CodexQueuedSend,
      overrides?: {
        connectionId?: string | null;
        expectedTurnId?: string | null;
      }
    ) => {
      const connectionId = overrides?.connectionId ?? sessionRef.current.connectionId;
      const expectedTurnId = overrides?.expectedTurnId ?? sessionRef.current.activeTurnId;
      const isRunning = overrides?.connectionId
        ? true
        : sessionRef.current.status === "running";

      if (!connectionId || !isRunning) {
        return false;
      }

      try {
        await sendCodexTurn({
          connectionId,
          prompt: send.prompt,
          expectedTurnId
        });
        setLastSubmittedPrompt(
          send.draft.trim() || send.contextItems[0]?.label || "Context turn"
        );
        const nextComposerState = clearComposerAfterSuccessfulSend();
        setDraft(nextComposerState.draft);
        setContextItems(nextComposerState.contextItems);
        setHighlightedContextItemId(null);
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
    const plan = planCodexSend(sessionRef.current.status, draft, contextItems);
    if (plan.kind === "noop") {
      return;
    }

    if (plan.kind === "dispatch") {
      void dispatchSend(plan.send);
      return;
    }

    setPendingSend(plan.send);
    pendingSendRef.current = plan.send;
    void startSession("send");
  }, [contextItems, dispatchSend, draft, startSession]);

  useEffect(() => {
    if (session.status !== "running" || !session.connectionId || !pendingSendRef.current) {
      return;
    }

    const queuedSend = pendingSendRef.current;
    pendingSendRef.current = null;
    setPendingSend(null);
    void dispatchSend(queuedSend, {
      connectionId: session.connectionId,
      expectedTurnId: session.activeTurnId
    });
  }, [dispatchSend, session.activeTurnId, session.connectionId, session.status]);

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

  const startNewChat = useCallback(() => {
    const connectionId = sessionRef.current.connectionId;

    setConversationEntries([]);
    setDraft("");
    setContextItems([]);
    setHighlightedContextItemId(null);
    pendingSendRef.current = null;
    setPendingSend(null);
    setPendingUserInputRequest(null);
    setLastSubmittedPrompt(null);
    requestComposerFocus();

    if (!connectionId) {
      newChatRequestedRef.current = false;
      setSession(createInitialSessionState());
      return;
    }

    newChatRequestedRef.current = true;
    setSession((current) => ({
      ...current,
      status: "stopping",
      message: "Starting a new chat..."
    }));

    void stopCodexAppServer(connectionId).catch((error) => {
      newChatRequestedRef.current = false;
      setSession({
        ...createInitialSessionState(),
        status: "error",
        message: `Failed to reset Codex chat: ${String(error)}`
      });
    });
  }, [requestComposerFocus]);

  const canSend = Boolean(buildCodexPrompt(draft, contextItems));

  return {
    session,
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
    submitUserInputRequest
  };
}
