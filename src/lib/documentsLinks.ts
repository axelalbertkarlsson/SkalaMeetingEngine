import type {
  DocumentGraphEdge,
  DocumentGraphLayoutNode,
  DocumentGraphNode,
  DocumentHeading,
  DocumentLinkReference,
  DocumentNoteIndexEntry,
  DocumentParsedWikiLink,
  DocumentResolvedLink,
  DocumentsIndex,
  DocumentTreeItem
} from "../models/documents";

const wikiLinkPattern = /\\?\[\\?\[([^[\]\n]+?)\\?\]\\?\]/g;
const markdownHeadingPattern = /^(#{1,6})[ \t]+(.+?)\s*$/gm;

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function splitPathSegments(value: string) {
  return value
    .split("/")
    .map((segment) => normalizeWhitespace(segment))
    .filter(Boolean);
}

export function normalizeDocumentPathKey(value: string) {
  return splitPathSegments(value)
    .map((segment) => segment.toLocaleLowerCase())
    .join("/");
}

function parseWikiLinkParts(inner: string) {
  const [targetPart, ...aliasParts] = inner.split("|");
  const alias = aliasParts.length > 0 ? aliasParts.join("|").trim() || null : null;
  const hashIndex = targetPart.indexOf("#");
  const rawPath = hashIndex >= 0 ? targetPart.slice(0, hashIndex) : targetPart;
  const rawHeading = hashIndex >= 0 ? targetPart.slice(hashIndex + 1) : "";
  const pathSegments = splitPathSegments(rawPath);

  return {
    targetPath: pathSegments.join("/"),
    pathSegments,
    alias,
    heading: normalizeWhitespace(rawHeading) || null
  };
}

function slugifyHeading(value: string) {
  return normalizeWhitespace(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export function getWikiLinkDisplayText(
  link: Pick<DocumentParsedWikiLink, "alias" | "heading" | "pathSegments" | "targetPath">
) {
  if (link.alias) {
    return link.alias;
  }

  const basename = link.pathSegments[link.pathSegments.length - 1] ?? link.targetPath;
  if (link.heading) {
    return `${basename} > ${link.heading}`;
  }

  return basename;
}

function collectNoteEntries(
  items: DocumentTreeItem[],
  markdownById: Record<string, string>,
  parentSegments: string[] = []
): DocumentNoteIndexEntry[] {
  const notes: DocumentNoteIndexEntry[] = [];

  items.forEach((item) => {
    const nextSegments = [...parentSegments, item.label];

    if ((item.kind ?? "folder") === "note") {
      const canonicalPath = nextSegments.join("/");
      notes.push({
        id: item.id,
        label: item.label,
        basename: item.label,
        canonicalPath,
        canonicalPathKey: normalizeDocumentPathKey(canonicalPath),
        preferredLinkPath: canonicalPath,
        preferredLinkPathKey: normalizeDocumentPathKey(canonicalPath),
        parentPath: parentSegments.length > 0 ? parentSegments.join("/") : null,
        pathSegments: nextSegments,
        markdown: markdownById[item.id] ?? "",
        headings: extractMarkdownHeadings(markdownById[item.id] ?? ""),
        basenameKey: normalizeDocumentPathKey(item.label),
        isBasenameUnique: false
      });
      return;
    }

    if (item.children?.length) {
      notes.push(...collectNoteEntries(item.children, markdownById, nextSegments));
    }
  });

  return notes;
}

function finalizeNoteEntries(notes: DocumentNoteIndexEntry[]) {
  const basenameCounts = new Map<string, number>();
  notes.forEach((note) => {
    basenameCounts.set(note.basenameKey, (basenameCounts.get(note.basenameKey) ?? 0) + 1);
  });

  return notes.map((note) => {
    const isBasenameUnique = (basenameCounts.get(note.basenameKey) ?? 0) === 1;
    const preferredLinkPath = isBasenameUnique ? note.basename : note.canonicalPath;

    return {
      ...note,
      headings: extractMarkdownHeadings(note.markdown),
      isBasenameUnique,
      preferredLinkPath,
      preferredLinkPathKey: normalizeDocumentPathKey(preferredLinkPath)
    };
  });
}

export function parseWikiLinks(markdown: string): DocumentParsedWikiLink[] {
  const links: DocumentParsedWikiLink[] = [];
  wikiLinkPattern.lastIndex = 0;

  for (const match of markdown.matchAll(wikiLinkPattern)) {
    const index = match.index ?? 0;
    if (index > 0 && markdown[index - 1] === "!") {
      continue;
    }

    const raw = match[0];
    const inner = match[1]?.trim() ?? "";
    if (!inner) {
      continue;
    }

    const parsed = parseWikiLinkParts(inner);
    if (!parsed.targetPath) {
      continue;
    }

    links.push({
      raw,
      from: index,
      to: index + raw.length,
      ...parsed
    });
  }

  return links;
}

export function extractMarkdownHeadings(markdown: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  markdownHeadingPattern.lastIndex = 0;

  for (const match of markdown.matchAll(markdownHeadingPattern)) {
    const level = match[1]?.length ?? 1;
    const text = normalizeWhitespace(match[2] ?? "");
    if (!text) {
      continue;
    }

    headings.push({
      level,
      text,
      slug: slugifyHeading(text)
    });
  }

  return headings;
}

function buildResolvedLink(
  sourceNote: DocumentNoteIndexEntry,
  parsedLink: DocumentParsedWikiLink,
  targetNote: DocumentNoteIndexEntry | null,
  match: DocumentResolvedLink["match"]
): DocumentResolvedLink {
  return {
    ...parsedLink,
    sourceNoteId: sourceNote.id,
    sourceCanonicalPath: sourceNote.canonicalPath,
    displayText: getWikiLinkDisplayText(parsedLink),
    targetNoteId: targetNote?.id ?? null,
    targetLabel: targetNote?.label ?? null,
    targetCanonicalPath: targetNote?.canonicalPath ?? null,
    targetPreferredLinkPath: targetNote?.preferredLinkPath ?? null,
    targetPathKey: normalizeDocumentPathKey(parsedLink.targetPath),
    isDangling: targetNote === null,
    match
  };
}

export function resolveDocumentLinkTarget(
  targetPath: string,
  index: Pick<DocumentsIndex, "notesByCanonicalPathKey" | "uniqueBasenameNoteIds" | "notesById">
) {
  const targetPathKey = normalizeDocumentPathKey(targetPath);
  if (!targetPathKey) {
    return {
      note: null,
      match: "none" as const
    };
  }

  const directMatch = index.notesByCanonicalPathKey[targetPathKey];
  if (directMatch) {
    return {
      note: directMatch,
      match: "canonical" as const
    };
  }

  const pathSegments = splitPathSegments(targetPath);
  if (pathSegments.length !== 1) {
    return {
      note: null,
      match: "none" as const
    };
  }

  const uniqueNoteId = index.uniqueBasenameNoteIds[targetPathKey];
  if (!uniqueNoteId) {
    return {
      note: null,
      match: "none" as const
    };
  }

  return {
    note: index.notesById[uniqueNoteId] ?? null,
    match: "basename" as const
  };
}

export function buildDocumentsIndex(
  tree: DocumentTreeItem[],
  markdownById: Record<string, string>
): DocumentsIndex {
  const noteEntries = finalizeNoteEntries(collectNoteEntries(tree, markdownById));
  const notesById = Object.fromEntries(noteEntries.map((note) => [note.id, note])) as Record<
    string,
    DocumentNoteIndexEntry
  >;
  const notesByCanonicalPathKey = Object.fromEntries(
    noteEntries.map((note) => [note.canonicalPathKey, note])
  ) as Record<string, DocumentNoteIndexEntry>;
  const notesByPreferredLinkPathKey = Object.fromEntries(
    noteEntries.map((note) => [note.preferredLinkPathKey, note])
  ) as Record<string, DocumentNoteIndexEntry>;
  const uniqueBasenameNoteIds = Object.fromEntries(
    noteEntries
      .filter((note) => note.isBasenameUnique)
      .map((note) => [note.basenameKey, note.id])
  ) as Record<string, string>;

  const linksBySourceId: Record<string, DocumentResolvedLink[]> = {};
  const backlinksByTargetId: Record<string, DocumentLinkReference[]> = {};
  const graphNodeMap = new Map<string, DocumentGraphNode>();
  const graphEdgeMap = new Map<string, DocumentGraphEdge>();

  noteEntries.forEach((note) => {
    graphNodeMap.set(note.id, {
      id: note.id,
      label: note.label,
      canonicalPath: note.canonicalPath,
      noteId: note.id,
      kind: "note",
      degree: 0
    });

    const parsedLinks = parseWikiLinks(note.markdown);
    const resolvedLinks = parsedLinks.map((parsedLink) => {
      const resolution = resolveDocumentLinkTarget(parsedLink.targetPath, {
        notesByCanonicalPathKey,
        uniqueBasenameNoteIds,
        notesById
      });
      return buildResolvedLink(note, parsedLink, resolution.note, resolution.match);
    });

    linksBySourceId[note.id] = resolvedLinks;

    resolvedLinks.forEach((link) => {
      if (link.targetNoteId) {
        const references = backlinksByTargetId[link.targetNoteId] ?? [];
        references.push({
          noteId: note.id,
          noteLabel: note.label,
          noteCanonicalPath: note.canonicalPath,
          link
        });
        backlinksByTargetId[link.targetNoteId] = references;
      }

      const targetNodeId = link.targetNoteId ?? `dangling:${link.targetPathKey}`;
      if (!link.targetNoteId && !graphNodeMap.has(targetNodeId)) {
        graphNodeMap.set(targetNodeId, {
          id: targetNodeId,
          label: link.pathSegments[link.pathSegments.length - 1] ?? link.targetPath,
          canonicalPath: link.targetPath,
          noteId: null,
          kind: "dangling",
          degree: 0
        });
      }

      const edgeKey = `${note.id}=>${targetNodeId}`;
      const existingEdge = graphEdgeMap.get(edgeKey);
      if (existingEdge) {
        existingEdge.count += 1;
        return;
      }

      graphEdgeMap.set(edgeKey, {
        id: edgeKey,
        source: note.id,
        target: targetNodeId,
        sourceNoteId: note.id,
        targetNoteId: link.targetNoteId,
        isDangling: link.isDangling,
        count: 1
      });
    });
  });

  graphEdgeMap.forEach((edge) => {
    const sourceNode = graphNodeMap.get(edge.source);
    const targetNode = graphNodeMap.get(edge.target);

    if (sourceNode) {
      sourceNode.degree += edge.count;
    }

    if (targetNode) {
      targetNode.degree += edge.count;
    }
  });

  return {
    notes: noteEntries,
    notesById,
    notesByCanonicalPathKey,
    notesByPreferredLinkPathKey,
    uniqueBasenameNoteIds,
    linksBySourceId,
    backlinksByTargetId,
    graphNodes: [...graphNodeMap.values()],
    graphEdges: [...graphEdgeMap.values()]
  };
}

function buildWikiLinkString(
  nextTargetPath: string,
  options: Pick<DocumentParsedWikiLink, "heading" | "alias">
) {
  const headingSuffix = options.heading ? `#${options.heading}` : "";
  const aliasSuffix = options.alias ? `|${options.alias}` : "";
  return `[[${nextTargetPath}${headingSuffix}${aliasSuffix}]]`;
}

export function rewriteResolvedWikiLinks(
  markdown: string,
  sourceNote: DocumentNoteIndexEntry,
  index: DocumentsIndex,
  transform: (link: DocumentResolvedLink) => string | null
) {
  return replaceResolvedWikiLinks(markdown, sourceNote, index, (link) => {
    const replacementTargetPath = transform(link);
    return replacementTargetPath ? buildWikiLinkString(replacementTargetPath, link) : null;
  });
}

export function replaceResolvedWikiLinks(
  markdown: string,
  sourceNote: DocumentNoteIndexEntry,
  index: DocumentsIndex,
  render: (link: DocumentResolvedLink) => string | null
) {
  const parsedLinks = parseWikiLinks(markdown);
  if (parsedLinks.length === 0) {
    return markdown;
  }

  let lastOffset = 0;
  let nextMarkdown = "";

  parsedLinks.forEach((parsedLink) => {
    const resolution = resolveDocumentLinkTarget(parsedLink.targetPath, index);
    const resolvedLink = buildResolvedLink(sourceNote, parsedLink, resolution.note, resolution.match);
    const replacement = render(resolvedLink);

    nextMarkdown += markdown.slice(lastOffset, parsedLink.from);
    nextMarkdown += replacement ?? parsedLink.raw;
    lastOffset = parsedLink.to;
  });

  nextMarkdown += markdown.slice(lastOffset);
  return nextMarkdown;
}

function stableNodeSeed(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function computeDocumentGraphLayout(
  nodes: DocumentGraphNode[],
  edges: DocumentGraphEdge[]
): DocumentGraphLayoutNode[] {
  if (nodes.length === 0) {
    return [];
  }

  const positions = new Map<string, { x: number; y: number }>();
  const velocities = new Map<string, { x: number; y: number }>();
  const radiusBase = Math.max(180, nodes.length * 28);

  nodes.forEach((node, index) => {
    const seed = stableNodeSeed(node.id);
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length);
    const radius = radiusBase + (seed % 140);
    positions.set(node.id, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    });
    velocities.set(node.id, { x: 0, y: 0 });
  });

  for (let iteration = 0; iteration < 180; iteration += 1) {
    const forces = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => {
      forces.set(node.id, { x: 0, y: 0 });
    });

    for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
        const firstNode = nodes[firstIndex];
        const secondNode = nodes[secondIndex];
        const firstPosition = positions.get(firstNode.id);
        const secondPosition = positions.get(secondNode.id);
        if (!firstPosition || !secondPosition) {
          continue;
        }

        let dx = secondPosition.x - firstPosition.x;
        let dy = secondPosition.y - firstPosition.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1) {
          distance = 1;
          dx = 1;
          dy = 0;
        }

        const repulsion = 34_000 / (distance * distance);
        const forceX = (dx / distance) * repulsion;
        const forceY = (dy / distance) * repulsion;
        const firstForce = forces.get(firstNode.id);
        const secondForce = forces.get(secondNode.id);

        if (firstForce && secondForce) {
          firstForce.x -= forceX;
          firstForce.y -= forceY;
          secondForce.x += forceX;
          secondForce.y += forceY;
        }
      }
    }

    edges.forEach((edge) => {
      const sourcePosition = positions.get(edge.source);
      const targetPosition = positions.get(edge.target);
      if (!sourcePosition || !targetPosition) {
        return;
      }

      let dx = targetPosition.x - sourcePosition.x;
      let dy = targetPosition.y - sourcePosition.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 1) {
        distance = 1;
        dx = 1;
        dy = 0;
      }

      const desiredLength = edge.isDangling ? 200 : 150;
      const spring = (distance - desiredLength) * 0.013 * Math.max(1, edge.count);
      const forceX = (dx / distance) * spring;
      const forceY = (dy / distance) * spring;
      const sourceForce = forces.get(edge.source);
      const targetForce = forces.get(edge.target);

      if (sourceForce && targetForce) {
        sourceForce.x += forceX;
        sourceForce.y += forceY;
        targetForce.x -= forceX;
        targetForce.y -= forceY;
      }
    });

    nodes.forEach((node) => {
      const position = positions.get(node.id);
      const velocity = velocities.get(node.id);
      const force = forces.get(node.id);
      if (!position || !velocity || !force) {
        return;
      }

      force.x += -position.x * 0.002;
      force.y += -position.y * 0.002;

      velocity.x = (velocity.x + force.x) * 0.84;
      velocity.y = (velocity.y + force.y) * 0.84;
      position.x += velocity.x;
      position.y += velocity.y;
    });
  }

  return nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    return {
      ...node,
      x: position.x,
      y: position.y
    };
  });
}

export function getPreferredDocumentLinkPath(note: Pick<DocumentNoteIndexEntry, "preferredLinkPath">) {
  return note.preferredLinkPath;
}

export function getDocumentOutgoingLinks(
  noteId: string | undefined,
  index: DocumentsIndex
): DocumentResolvedLink[] {
  if (!noteId) {
    return [];
  }

  return index.linksBySourceId[noteId] ?? [];
}

export function getDocumentBacklinks(
  noteId: string | undefined,
  index: DocumentsIndex
): DocumentLinkReference[] {
  if (!noteId) {
    return [];
  }

  return index.backlinksByTargetId[noteId] ?? [];
}
