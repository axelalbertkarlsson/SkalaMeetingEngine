import { invoke } from "@tauri-apps/api/core";

export interface PreparedCodexContextFile {
  path: string;
  content: string;
}

export async function prepareCodexContextFileForWorkspace(
  workspaceRoot: string,
  sourcePath: string
): Promise<PreparedCodexContextFile | null> {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return await invoke<PreparedCodexContextFile>("documents_prepare_file_for_codex", {
      workspaceRoot,
      sourcePath
    });
  } catch (error) {
    console.error("[codex] Failed to prepare context file for workspace", {
      workspaceRoot,
      sourcePath,
      error
    });
    return null;
  }
}
