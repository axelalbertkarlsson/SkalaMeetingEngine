import assert from "node:assert/strict";
import {
  buildDocumentsIndex,
  cleanupDocumentGraphPinnedPositions,
  computeDocumentGraphLayout,
  getDocumentGraphFocus,
  parseWikiLinks,
  rewriteResolvedWikiLinks
} from "../src/lib/documentsLinks.ts";
import {
  defaultDocumentGraphForceSettings,
  documentGraphBaseForceConstants,
  documentGraphForceSettingsToParameters,
  stepDocumentGraphSimulation,
  type DocumentGraphSimulationNode
} from "../src/lib/documentGraphSimulation.ts";
import type { DocumentTreeItem } from "../src/models/documents.ts";

function createTree(items: DocumentTreeItem[]): DocumentTreeItem[] {
  return items;
}

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest("parseWikiLinks supports core Obsidian variants", () => {
  const links = parseWikiLinks(
    "Links: [[Roadmap]], [[Work/Plan]], [[Decision log|Decision]], [[Launch#Open questions]]."
  );

  assert.equal(links.length, 4);
  assert.deepEqual(
    links.map((link) => ({
      targetPath: link.targetPath,
      alias: link.alias,
      heading: link.heading
    })),
    [
      { targetPath: "Roadmap", alias: null, heading: null },
      { targetPath: "Work/Plan", alias: null, heading: null },
      { targetPath: "Decision log", alias: "Decision", heading: null },
      { targetPath: "Launch", alias: null, heading: "Open questions" }
    ]
  );
});

runTest("parseWikiLinks supports escaped wiki-links from editor serialization", () => {
  const links = parseWikiLinks(
    String.raw`Links: \[\[Roadmap\]\], \[\[Work/Plan\]\], \[\[Decision log|Decision\]\], \[\[Launch#Open questions\]\].`
  );

  assert.equal(links.length, 4);
  assert.deepEqual(
    links.map((link) => ({
      targetPath: link.targetPath,
      alias: link.alias,
      heading: link.heading
    })),
    [
      { targetPath: "Roadmap", alias: null, heading: null },
      { targetPath: "Work/Plan", alias: null, heading: null },
      { targetPath: "Decision log", alias: "Decision", heading: null },
      { targetPath: "Launch", alias: null, heading: "Open questions" }
    ]
  );
});

runTest("duplicate basenames require canonical paths", () => {
  const tree = createTree([
    {
      id: "folder-alpha",
      label: "Alpha",
      kind: "folder",
      children: [{ id: "note-alpha", label: "Plan", kind: "note" }]
    },
    {
      id: "folder-beta",
      label: "Beta",
      kind: "folder",
      children: [
        { id: "note-beta", label: "Plan", kind: "note" },
        { id: "note-source", label: "Source", kind: "note" }
      ]
    }
  ]);

  const index = buildDocumentsIndex(tree, {
    "note-source": "See [[Plan]] and [[Alpha/Plan]]."
  });

  const outgoing = index.linksBySourceId["note-source"];
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[0]?.targetNoteId, null);
  assert.equal(outgoing[1]?.targetNoteId, "note-alpha");
});

runTest("dangling links resolve once the target note exists", () => {
  const initialTree = createTree([{ id: "note-source", label: "Source", kind: "note" }]);
  const initialIndex = buildDocumentsIndex(initialTree, {
    "note-source": "Pending [[Research]]."
  });

  assert.equal(initialIndex.linksBySourceId["note-source"]?.[0]?.targetNoteId, null);

  const nextTree = createTree([
    { id: "note-source", label: "Source", kind: "note" },
    { id: "note-research", label: "Research", kind: "note" }
  ]);
  const nextIndex = buildDocumentsIndex(nextTree, {
    "note-source": "Pending [[Research]].",
    "note-research": "# Research"
  });

  assert.equal(nextIndex.linksBySourceId["note-source"]?.[0]?.targetNoteId, "note-research");
  assert.equal(nextIndex.backlinksByTargetId["note-research"]?.length, 1);
});

runTest("rewrites preserve alias and heading", () => {
  const previousTree = createTree([
    { id: "note-source", label: "Source", kind: "note" },
    {
      id: "folder-work",
      label: "Work",
      kind: "folder",
      children: [{ id: "note-plan", label: "Plan", kind: "note" }]
    }
  ]);
  const previousMarkdownById = {
    "note-source": "See [[Work/Plan#Next steps|Delivery plan]] and [[Work/Plan]].",
    "note-plan": "# Plan"
  };
  const previousIndex = buildDocumentsIndex(previousTree, previousMarkdownById);

  const nextTree = createTree([
    { id: "note-source", label: "Source", kind: "note" },
    {
      id: "folder-work",
      label: "Work",
      kind: "folder",
      children: [{ id: "note-plan", label: "Execution plan", kind: "note" }]
    }
  ]);
  const nextIndex = buildDocumentsIndex(nextTree, previousMarkdownById);
  const sourceNote = previousIndex.notesById["note-source"];

  const nextMarkdown = rewriteResolvedWikiLinks(
    previousMarkdownById["note-source"],
    sourceNote,
    previousIndex,
    (link) => {
      if (link.targetNoteId !== "note-plan") {
        return null;
      }

      return nextIndex.notesById["note-plan"]?.preferredLinkPath ?? null;
    }
  );

  assert.equal(
    nextMarkdown,
    "See [[Execution plan#Next steps|Delivery plan]] and [[Execution plan]]."
  );
});

runTest("graph focus returns one-hop neighbors and edges", () => {
  const focus = getDocumentGraphFocus("note-b", [
    {
      id: "note-a=>note-b",
      source: "note-a",
      target: "note-b",
      sourceNoteId: "note-a",
      targetNoteId: "note-b",
      isDangling: false,
      count: 1
    },
    {
      id: "note-b=>note-c",
      source: "note-b",
      target: "note-c",
      sourceNoteId: "note-b",
      targetNoteId: "note-c",
      isDangling: false,
      count: 1
    },
    {
      id: "note-c=>note-d",
      source: "note-c",
      target: "note-d",
      sourceNoteId: "note-c",
      targetNoteId: "note-d",
      isDangling: false,
      count: 1
    }
  ]);

  assert.deepEqual(focus.nodeIds.sort(), ["note-a", "note-b", "note-c"]);
  assert.deepEqual(focus.edgeIds.sort(), ["note-a=>note-b", "note-b=>note-c"]);
});

runTest("graph layout preserves pinned positions while laying out other nodes", () => {
  const layout = computeDocumentGraphLayout(
    [
      { id: "note-a", label: "Note A", canonicalPath: "Note A", noteId: "note-a", kind: "note", degree: 1 },
      { id: "note-b", label: "Note B", canonicalPath: "Note B", noteId: "note-b", kind: "note", degree: 1 }
    ],
    [
      {
        id: "note-a=>note-b",
        source: "note-a",
        target: "note-b",
        sourceNoteId: "note-a",
        targetNoteId: "note-b",
        isDangling: false,
        count: 1
      }
    ],
    {
      pinnedPositions: {
        "note-a": { x: 120, y: -80 }
      }
    }
  );

  const pinnedNode = layout.find((node) => node.id === "note-a");
  const floatingNode = layout.find((node) => node.id === "note-b");

  assert.ok(pinnedNode);
  assert.ok(floatingNode);
  assert.equal(pinnedNode?.x, 120);
  assert.equal(pinnedNode?.y, -80);
  assert.equal(typeof floatingNode?.x, "number");
  assert.equal(typeof floatingNode?.y, "number");
});

runTest("graph pinned position cleanup removes stale node ids", () => {
  const cleaned = cleanupDocumentGraphPinnedPositions(
    {
      "note-a": { x: 10, y: 20 },
      "note-z": { x: 30, y: 40 }
    },
    ["note-a", "note-b"]
  );

  assert.deepEqual(cleaned, {
    "note-a": { x: 10, y: 20 }
  });
});

runTest("graph force defaults map to the legacy layout constants", () => {
  const parameters = documentGraphForceSettingsToParameters(defaultDocumentGraphForceSettings);

  assert.equal(parameters.centerStrength, documentGraphBaseForceConstants.centerStrength);
  assert.equal(parameters.repulsionStrength, documentGraphBaseForceConstants.repulsionStrength);
  assert.equal(parameters.linkStrength, documentGraphBaseForceConstants.linkStrength);
  assert.equal(parameters.linkDistance, documentGraphBaseForceConstants.linkDistance);
});

runTest("graph simulation keeps dragged node fixed at the supplied point", () => {
  const nodes: DocumentGraphSimulationNode[] = [
    {
      id: "note-a",
      label: "Note A",
      canonicalPath: "Note A",
      noteId: "note-a",
      kind: "note",
      degree: 1,
      x: 0,
      y: 0,
      vx: 10,
      vy: -10
    },
    {
      id: "note-b",
      label: "Note B",
      canonicalPath: "Note B",
      noteId: "note-b",
      kind: "note",
      degree: 1,
      x: 200,
      y: 0,
      vx: 0,
      vy: 0
    }
  ];

  const nextNodes = stepDocumentGraphSimulation(nodes, [], defaultDocumentGraphForceSettings, {
    fixedNode: { nodeId: "note-a", x: 42, y: -36 },
    alpha: 1
  });
  const draggedNode = nextNodes.find((node) => node.id === "note-a");

  assert.equal(draggedNode?.x, 42);
  assert.equal(draggedNode?.y, -36);
  assert.equal(draggedNode?.vx, 0);
  assert.equal(draggedNode?.vy, 0);
});

runTest("graph simulation pushes non-dragged nodes away from a dragged collision", () => {
  const nodes: DocumentGraphSimulationNode[] = [
    {
      id: "note-a",
      label: "Note A",
      canonicalPath: "Note A",
      noteId: "note-a",
      kind: "note",
      degree: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0
    },
    {
      id: "note-b",
      label: "Note B",
      canonicalPath: "Note B",
      noteId: "note-b",
      kind: "note",
      degree: 0,
      x: 1,
      y: 0,
      vx: 0,
      vy: 0
    }
  ];

  const nextNodes = stepDocumentGraphSimulation(nodes, [], defaultDocumentGraphForceSettings, {
    fixedNode: { nodeId: "note-a", x: 0, y: 0 },
    nodeRadiusById: new Map([
      ["note-a", 20],
      ["note-b", 20]
    ]),
    alpha: 1
  });
  const pushedNode = nextNodes.find((node) => node.id === "note-b");

  assert.ok(pushedNode);
  assert.ok(Math.hypot(pushedNode!.x, pushedNode!.y) >= 50);
});

runTest("graph force link distance slider changes the spring target distance", () => {
  const compactParameters = documentGraphForceSettingsToParameters({
    ...defaultDocumentGraphForceSettings,
    linkDistance: 0
  });
  const expandedParameters = documentGraphForceSettingsToParameters({
    ...defaultDocumentGraphForceSettings,
    linkDistance: 100
  });

  assert.equal(compactParameters.linkDistance, 80);
  assert.equal(expandedParameters.linkDistance, 220);
  assert.ok(expandedParameters.linkDistance > compactParameters.linkDistance);
});

console.log("All document link tests passed.");
