import { invoke } from "@tauri-apps/api/core";
import type {
  CodexAppConnectResponse,
  CodexAppSendTurnResponse
} from "../models/codex.js";

interface OperationAck {
  ok: boolean;
  message: string;
}

interface CodexAppConnectWireResponse {
  connection_id: string;
  message: string;
}

interface CodexAppSendTurnWireResponse {
  turn_id: string;
  turn?: unknown | null;
}

interface CodexAppListThreadsWireResponse {
  threads: unknown[];
}

interface CodexAppThreadWireResponse {
  thread: unknown;
}

export async function connectCodexAppServer(request: {
  workspacePath: string;
  command: string;
}) {
  const response = await invoke<CodexAppConnectWireResponse>("codex_app_connect", {
    request: {
      workspace_path: request.workspacePath,
      command: request.command
    }
  });

  return {
    connectionId: response.connection_id,
    message: response.message
  } satisfies CodexAppConnectResponse;
}

export async function listCodexThreads(request: {
  connectionId: string;
  cwd: string;
}) {
  const response = await invoke<CodexAppListThreadsWireResponse>("codex_app_list_threads", {
    request: {
      connection_id: request.connectionId,
      cwd: request.cwd
    }
  });

  return response.threads;
}

export async function readCodexThread(request: {
  connectionId: string;
  threadId: string;
}) {
  const response = await invoke<CodexAppThreadWireResponse>("codex_app_read_thread", {
    request: {
      connection_id: request.connectionId,
      thread_id: request.threadId
    }
  });

  return response.thread;
}

export async function resumeCodexThread(request: {
  connectionId: string;
  threadId: string;
}) {
  const response = await invoke<CodexAppThreadWireResponse>("codex_app_resume_thread", {
    request: {
      connection_id: request.connectionId,
      thread_id: request.threadId
    }
  });

  return response.thread;
}

export async function startCodexThread(request: {
  connectionId: string;
  workspacePath: string;
}) {
  const response = await invoke<CodexAppThreadWireResponse>("codex_app_start_thread", {
    request: {
      connection_id: request.connectionId,
      workspace_path: request.workspacePath
    }
  });

  return response.thread;
}

export async function archiveCodexThread(request: {
  connectionId: string;
  threadId: string;
}) {
  const response = await invoke<OperationAck>("codex_app_archive_thread", {
    request: {
      connection_id: request.connectionId,
      thread_id: request.threadId
    }
  });

  return response.message;
}

export async function sendCodexTurn(request: {
  connectionId: string;
  prompt: string;
  expectedTurnId?: string | null;
}) {
  const response = await invoke<CodexAppSendTurnWireResponse>("codex_app_send_turn", {
    request: {
      connection_id: request.connectionId,
      prompt: request.prompt,
      expected_turn_id: request.expectedTurnId ?? null
    }
  });

  return {
    turnId: response.turn_id,
    turn: response.turn ?? null
  } satisfies CodexAppSendTurnResponse;
}

export async function stopCodexAppServer(connectionId: string) {
  const response = await invoke<OperationAck>("codex_app_stop", {
    request: {
      connection_id: connectionId
    }
  });

  return response.message;
}

export async function respondToCodexServerRequest(request: {
  connectionId: string;
  requestId: string | number | null;
  result: unknown;
}) {
  const response = await invoke<OperationAck>("codex_app_respond_to_server_request", {
    request: {
      connection_id: request.connectionId,
      request_id: request.requestId,
      result: request.result
    }
  });

  return response.message;
}
