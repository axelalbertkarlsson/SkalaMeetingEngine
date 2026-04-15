import assert from "node:assert/strict";
import {
  buildDocumentsIndex,
  parseWikiLinks,
  rewriteResolvedWikiLinks
} from "../src/lib/documentsLinks.ts";
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

console.log("All document link tests passed.");
