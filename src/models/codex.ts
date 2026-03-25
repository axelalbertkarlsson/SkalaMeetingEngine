export type CodexSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface CodexSessionState {
  connectionId: string | null;
  activeThreadId: string | null;
  activeTurnId: string | null;
  status: CodexSessionStatus;
  message: string;
  lastEventMethod: string | null;
}

export type CodexContextItemKind = "document_note" | "meeting_artifact";

export interface CodexContextItem {
  id: string;
  kind: CodexContextItemKind;
  label: string;
  path: string;
  sourceId: string;
}

export type CodexConversationEntryKind =
  | "user_message"
  | "agent_message"
  | "command_execution"
  | "file_change"
  | "event";

export interface CodexConversationEntry {
  id: string;
  kind: CodexConversationEntryKind;
  title: string;
  text: string;
  itemId?: string;
  turnId?: string;
  status?: string | null;
  meta?: string | null;
  phase?: string | null;
}

export interface CodexThreadSummary {
  id: string;
  name: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  status: string | null;
  preview: string | null;
  archived: boolean;
}

export interface CodexThreadDetails extends CodexThreadSummary {
  conversationEntries: CodexConversationEntry[];
}

export interface CodexThreadLocalState {
  customTitle: string | null;
  draft: string;
  contextItems: CodexContextItem[];
  lastOpenedAt: string | null;
  lastSubmittedPrompt: string | null;
}

export interface CodexThreadLocalStore {
  lastOpenedThreadId: string | null;
  threads: Record<string, CodexThreadLocalState>;
}

export type CodexAppLifecyclePhase = "connected" | "stopped" | "error";

export type CodexAppEventPayload =
  | {
      kind: "notification";
      connection_id: string;
      method: string;
      params: unknown;
    }
  | {
      kind: "server_request";
      connection_id: string;
      request_id: string | number | null;
      method: string;
      params: unknown;
    }
  | {
      kind: "stderr";
      connection_id: string;
      text: string;
    }
  | {
      kind: "lifecycle";
      connection_id: string;
      phase: CodexAppLifecyclePhase;
      message: string;
      thread_id?: string | null;
    };

export interface CodexAppConnectResponse {
  connectionId: string;
  message: string;
}

export interface CodexAppSendTurnResponse {
  turnId: string;
  turn?: unknown | null;
}
