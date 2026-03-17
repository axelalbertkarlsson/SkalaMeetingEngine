import { invoke } from "@tauri-apps/api/core";

export function isDocumentsFilePersistenceAvailable() {
  return typeof window !== "undefined";
}

function normalizeBasePath(basePath?: string): string | null {
  const trimmed = basePath?.trim();
  return trimmed ? trimmed : null;
}

export async function readDocumentNoteFile(
  noteId: string,
  basePath?: string
): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return await invoke<string | null>("documents_read_note", {
      noteId,
      basePath: normalizeBasePath(basePath)
    });
  } catch (error) {
    console.error("[documents] Failed to read note file", { noteId, basePath, error });
    return null;
  }
}

export async function writeDocumentNoteFile(
  noteId: string,
  content: string,
  basePath?: string
): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    await invoke("documents_write_note", {
      noteId,
      content,
      basePath: normalizeBasePath(basePath)
    });
    return true;
  } catch (error) {
    console.error("[documents] Failed to write note file", { noteId, basePath, error });
    return false;
  }
}

export async function deleteDocumentNoteFile(noteId: string, basePath?: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    await invoke("documents_delete_note", {
      noteId,
      basePath: normalizeBasePath(basePath)
    });
    return true;
  } catch (error) {
    console.error("[documents] Failed to delete note file", { noteId, basePath, error });
    return false;
  }
}

export async function copyDocumentNoteFile(
  sourceNoteId: string,
  targetNoteId: string,
  basePath?: string
): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    await invoke("documents_copy_note", {
      sourceNoteId,
      targetNoteId,
      basePath: normalizeBasePath(basePath)
    });
    return true;
  } catch (error) {
    console.error("[documents] Failed to copy note file", {
      sourceNoteId,
      targetNoteId,
      basePath,
      error
    });
    return false;
  }
}

