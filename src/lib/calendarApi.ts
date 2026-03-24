import { invoke } from "@tauri-apps/api/core";
import type { CalendarSource, CalendarSourceSnapshot } from "../models/calendar";

interface WorkspaceRef {
  workspaceId: string;
  workspaceRoot: string;
}

function mapSource(source: any): CalendarSource {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    workspaceRoot: source.workspaceRoot,
    provider: "ics",
    kind: source.kind,
    name: source.name,
    url: source.url ?? undefined,
    fileName: source.fileName ?? undefined,
    storedPath: source.storedPath,
    createdAt: source.createdAt,
    lastSyncedAt: source.lastSyncedAt ?? undefined,
    lastSyncError: source.lastSyncError ?? undefined
  };
}

function mapSourceSnapshot(snapshot: any): CalendarSourceSnapshot {
  return {
    source: mapSource(snapshot.source),
    content: snapshot.content ?? null,
    fetchedAt: snapshot.fetchedAt,
    stale: Boolean(snapshot.stale),
    error: snapshot.error ?? undefined
  };
}

export async function listCalendarSources(workspace: WorkspaceRef): Promise<CalendarSource[]> {
  const sources = await invoke<any[]>("list_calendar_sources", { request: workspace });
  return sources.map(mapSource);
}

export async function loadCalendarSourceSnapshots(
  workspace: WorkspaceRef
): Promise<CalendarSourceSnapshot[]> {
  const snapshots = await invoke<any[]>("load_calendar_source_snapshots", { request: workspace });
  return snapshots.map(mapSourceSnapshot);
}

export async function addCalendarSubscription(
  workspace: WorkspaceRef,
  input: { name: string; url: string }
): Promise<CalendarSource> {
  const source = await invoke<any>("add_calendar_subscription", {
    request: {
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      name: input.name,
      url: input.url
    }
  });

  return mapSource(source);
}

export async function importCalendarSource(
  workspace: WorkspaceRef,
  input: { name: string; file: File }
): Promise<CalendarSource> {
  const bytes = Array.from(new Uint8Array(await input.file.arrayBuffer()));
  const source = await invoke<any>("import_calendar_source", {
    request: {
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.workspaceRoot,
      name: input.name,
      fileName: input.file.name,
      fileBytes: bytes
    }
  });

  return mapSource(source);
}

export async function removeCalendarSource(
  workspaceRoot: string,
  sourceId: string
): Promise<void> {
  await invoke("remove_calendar_source", {
    request: {
      workspaceRoot,
      sourceId
    }
  });
}
