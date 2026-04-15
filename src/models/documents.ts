export type DocumentTreeItemKind = "folder" | "note";

export interface DocumentTreeItem {
  id: string;
  label: string;
  kind?: DocumentTreeItemKind;
  children?: DocumentTreeItem[];
}

export interface DocumentHeading {
  level: number;
  text: string;
  slug: string;
}

export interface DocumentParsedWikiLink {
  raw: string;
  from: number;
  to: number;
  targetPath: string;
  pathSegments: string[];
  alias: string | null;
  heading: string | null;
}

export interface DocumentNoteIndexEntry {
  id: string;
  label: string;
  basename: string;
  canonicalPath: string;
  canonicalPathKey: string;
  preferredLinkPath: string;
  preferredLinkPathKey: string;
  parentPath: string | null;
  pathSegments: string[];
  markdown: string;
  headings: DocumentHeading[];
  basenameKey: string;
  isBasenameUnique: boolean;
}

export type DocumentResolvedLinkMatch = "canonical" | "basename" | "none";

export interface DocumentResolvedLink extends DocumentParsedWikiLink {
  sourceNoteId: string;
  sourceCanonicalPath: string;
  displayText: string;
  targetNoteId: string | null;
  targetLabel: string | null;
  targetCanonicalPath: string | null;
  targetPreferredLinkPath: string | null;
  targetPathKey: string;
  isDangling: boolean;
  match: DocumentResolvedLinkMatch;
}

export interface DocumentLinkReference {
  noteId: string;
  noteLabel: string;
  noteCanonicalPath: string;
  link: DocumentResolvedLink;
}

export interface DocumentGraphNode {
  id: string;
  label: string;
  canonicalPath: string;
  noteId: string | null;
  kind: "note" | "dangling";
  degree: number;
}

export interface DocumentGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceNoteId: string;
  targetNoteId: string | null;
  isDangling: boolean;
  count: number;
}

export interface DocumentsIndex {
  notes: DocumentNoteIndexEntry[];
  notesById: Record<string, DocumentNoteIndexEntry>;
  notesByCanonicalPathKey: Record<string, DocumentNoteIndexEntry>;
  notesByPreferredLinkPathKey: Record<string, DocumentNoteIndexEntry>;
  uniqueBasenameNoteIds: Record<string, string>;
  linksBySourceId: Record<string, DocumentResolvedLink[]>;
  backlinksByTargetId: Record<string, DocumentLinkReference[]>;
  graphNodes: DocumentGraphNode[];
  graphEdges: DocumentGraphEdge[];
}

export interface DocumentGraphLayoutNode extends DocumentGraphNode {
  x: number;
  y: number;
}
