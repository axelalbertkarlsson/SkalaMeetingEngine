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
  thread_id: string;
  message: string;
}

interface CodexAppSendTurnWireResponse {
  turn_id: string;
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
    threadId: response.thread_id,
    message: response.message
  } satisfies CodexAppConnectResponse;
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
    turnId: response.turn_id
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
