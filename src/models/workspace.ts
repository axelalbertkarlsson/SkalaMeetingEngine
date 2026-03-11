export type WorkspaceStatus = "active" | "archived";

export interface ObsidianConfig {
  vaultPath: string;
  publishFolder: string;
  safeMode: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  status: WorkspaceStatus;
  createdAt: string;
  tags: string[];
  obsidian: ObsidianConfig;
}
