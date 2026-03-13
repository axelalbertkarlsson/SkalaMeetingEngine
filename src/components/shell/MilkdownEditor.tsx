import { useEffect, useRef } from "react";
import { editorViewCtx } from "@milkdown/core";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import { Fragment, type Node as ProseMirrorNode } from "@milkdown/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";

interface MilkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
}

interface MilkdownEditorInnerProps {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
}

function posAtChildIndex(doc: ProseMirrorNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) {
    pos += doc.child(i).nodeSize;
  }
  return pos;
}

function getSelectedBlockRange(state: EditorView["state"]): { start: number; end: number } {
  const { doc, selection } = state;
  const maxIndex = Math.max(0, doc.childCount - 1);

  if (selection.empty || selection instanceof NodeSelection) {
    const index = Math.min(Math.max(selection.$from.index(0), 0), maxIndex);
    return { start: index, end: index };
  }

  let start = Math.min(selection.$from.index(0), selection.$to.index(0));
  let end = Math.max(selection.$from.index(0), selection.$to.index(0));

  if (selection.from < selection.to && selection.$to.parentOffset === 0 && end > start) {
    end -= 1;
  }

  start = Math.min(Math.max(start, 0), maxIndex);
  end = Math.min(Math.max(end, start), maxIndex);

  return { start, end };
}

function moveSelectedBlock(view: EditorView, direction: "up" | "down"): boolean {
  const { state } = view;
  const { doc } = state;

  if (doc.childCount < 2) {
    return false;
  }

  const range = getSelectedBlockRange(state);
  const selectedSize = range.end - range.start + 1;

  if (direction === "up" && range.start <= 0) {
    return false;
  }

  if (direction === "down" && range.end >= doc.childCount - 1) {
    return false;
  }

  const selectedNodes: ProseMirrorNode[] = [];
  for (let i = range.start; i <= range.end; i += 1) {
    selectedNodes.push(doc.child(i));
  }

  let replaceFrom = 0;
  let replaceTo = 0;
  let replacementNodes: ProseMirrorNode[] = [];
  let movedStartIndex = range.start;

  if (direction === "down") {
    const adjacent = doc.child(range.end + 1);
    replaceFrom = posAtChildIndex(doc, range.start);
    replaceTo = posAtChildIndex(doc, range.end + 2);
    replacementNodes = [adjacent, ...selectedNodes];
    movedStartIndex = range.start + 1;
  } else {
    const adjacent = doc.child(range.start - 1);
    replaceFrom = posAtChildIndex(doc, range.start - 1);
    replaceTo = posAtChildIndex(doc, range.end + 1);
    replacementNodes = [...selectedNodes, adjacent];
    movedStartIndex = range.start - 1;
  }

  let tr = state.tr.replaceWith(replaceFrom, replaceTo, Fragment.fromArray(replacementNodes));

  const movedStartPos = posAtChildIndex(tr.doc, movedStartIndex);
  if (selectedSize === 1) {
    tr = tr.setSelection(NodeSelection.create(tr.doc, movedStartPos));
  } else {
    const movedEndPos = posAtChildIndex(tr.doc, movedStartIndex + selectedSize);
    const from = Math.min(movedStartPos + 1, tr.doc.content.size);
    const to = Math.max(from, movedEndPos - 1);

    try {
      tr = tr.setSelection(TextSelection.create(tr.doc, from, to));
    } catch {
      tr = tr.setSelection(NodeSelection.create(tr.doc, movedStartPos));
    }
  }

  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function getHandleBlockIndex(view: EditorView, handleElement: HTMLElement): number | null {
  const editorRect = view.dom.getBoundingClientRect();
  const handleRect = handleElement.getBoundingClientRect();

  const probeY = Math.min(Math.max(handleRect.top + handleRect.height / 2, editorRect.top + 1), editorRect.bottom - 1);

  const probeXs = [
    editorRect.left + 24,
    editorRect.left + 72,
    editorRect.left + 128,
    editorRect.left + 192,
    editorRect.left + Math.min(256, Math.max(32, editorRect.width - 16)),
    editorRect.left + editorRect.width * 0.5
  ];

  const currentDoc = view.state.doc;

  for (const x of probeXs) {
    const probeX = Math.min(Math.max(x, editorRect.left + 1), editorRect.right - 1);
    const resolved = view.posAtCoords({
      left: probeX,
      top: probeY
    });

    if (!resolved || resolved.inside == null || resolved.inside < 0) {
      continue;
    }

    const $pos = currentDoc.resolve(resolved.inside);
    return Math.min($pos.index(0), currentDoc.childCount - 1);
  }

  if (currentDoc.childCount > 0) {
    return Math.min(view.state.selection.$from.index(0), currentDoc.childCount - 1);
  }

  return null;
}

function selectBlockByIndex(view: EditorView, blockIndex: number) {
  const currentDoc = view.state.doc;
  const blockPos = posAtChildIndex(currentDoc, blockIndex);

  const tr = view.state.tr.setSelection(NodeSelection.create(currentDoc, blockPos));
  view.dispatch(tr);
  view.focus();
}

function MilkdownEditorInner({ value, onChange, className }: MilkdownEditorInnerProps) {
  const onChangeRef = useRef(onChange);
  const initialValueRef = useRef(value);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: initialValueRef.current,
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: {
          blockHandle: {
            getOffset: () => -8
          }
        }
      }
    });

    crepeRef.current = crepe;

    crepe.editor.use(listener).config((ctx) => {
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
    });

    return crepe;
  }, []);

  useEffect(() => {
    return () => {
      crepeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const applyDragHandleFix = () => {
      const handles = container.querySelectorAll<HTMLElement>(".milkdown-block-handle");
      handles.forEach((handle) => {
        handle.draggable = false;

        const operationItems = handle.querySelectorAll<HTMLElement>(".operation-item");
        const dragItem = operationItems.item(operationItems.length - 1);
        if (dragItem) {
          dragItem.draggable = false;
          dragItem.title = "Drag to reorder block";
        }
      });
    };

    applyDragHandleFix();

    const observer = new MutationObserver(() => {
      applyDragHandleFix();
    });

    observer.observe(container, {
      childList: true,
      subtree: true
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const getView = (): EditorView | null => {
      const crepe = crepeRef.current;
      if (!crepe) {
        return null;
      }

      return crepe.editor.ctx.get(editorViewCtx);
    };

    let dragging = false;
    let activeDragItem: HTMLElement | null = null;
    let dragShield: HTMLDivElement | null = null;
    let lastPointerY = 0;
    let pendingDeltaY = 0;
    const stepThreshold = 24;

    const removeDragShield = () => {
      if (dragShield && dragShield.parentElement) {
        dragShield.parentElement.removeChild(dragShield);
      }
      dragShield = null;
    };

    const ensureDragShield = () => {
      if (dragShield) {
        return;
      }

      const shield = document.createElement("div");
      shield.setAttribute("aria-hidden", "true");
      Object.assign(shield.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        cursor: "grabbing",
        background: "transparent"
      });

      document.body.appendChild(shield);
      dragShield = shield;
    };

    const clearActiveDragState = () => {
      dragging = false;
      pendingDeltaY = 0;

      if (activeDragItem) {
        activeDragItem.classList.remove("active");
      }

      activeDragItem = null;
      document.body.style.userSelect = "";
      removeDragShield();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const dragItem = target.closest(".milkdown-block-handle .operation-item:last-child");
      if (!(dragItem instanceof HTMLElement) || !container.contains(dragItem as Node)) {
        return;
      }

      const view = getView();
      if (!view) {
        return;
      }

      const handleBlockIndex = getHandleBlockIndex(view, dragItem);
      if (handleBlockIndex == null) {
        return;
      }

      const selectedRange = getSelectedBlockRange(view.state);
      const selectionSpansMultipleBlocks = !view.state.selection.empty && selectedRange.end > selectedRange.start;
      const handleInsideSelection =
        handleBlockIndex >= selectedRange.start && handleBlockIndex <= selectedRange.end;

      if (!(selectionSpansMultipleBlocks && handleInsideSelection)) {
        selectBlockByIndex(view, handleBlockIndex);
      }

      dragging = true;
      activeDragItem = dragItem;
      lastPointerY = event.clientY;
      pendingDeltaY = 0;

      dragItem.classList.add("active");
      document.body.style.userSelect = "none";
      ensureDragShield();

      event.preventDefault();
      event.stopPropagation();
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) {
        return;
      }

      const view = getView();
      if (!view) {
        return;
      }

      const deltaY = event.clientY - lastPointerY;
      lastPointerY = event.clientY;
      pendingDeltaY += deltaY;

      while (pendingDeltaY >= stepThreshold) {
        const moved = moveSelectedBlock(view, "down");
        if (!moved) {
          pendingDeltaY = 0;
          break;
        }
        pendingDeltaY -= stepThreshold;
      }

      while (pendingDeltaY <= -stepThreshold) {
        const moved = moveSelectedBlock(view, "up");
        if (!moved) {
          pendingDeltaY = 0;
          break;
        }
        pendingDeltaY += stepThreshold;
      }

      event.preventDefault();
    };

    const onMouseUp = () => {
      if (!dragging) {
        return;
      }

      clearActiveDragState();
    };

    const onWindowBlur = () => {
      if (!dragging) {
        return;
      }

      clearActiveDragState();
    };

    container.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      clearActiveDragState();
      container.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const scrollHost = container;
      const canScrollVertically = scrollHost.scrollHeight > scrollHost.clientHeight;
      const canScrollHorizontally = scrollHost.scrollWidth > scrollHost.clientWidth;

      if (!canScrollVertically && !canScrollHorizontally) {
        return;
      }

      if (canScrollVertically && event.deltaY !== 0) {
        scrollHost.scrollTop += event.deltaY;
      }

      if (canScrollHorizontally && event.deltaX !== 0) {
        scrollHost.scrollLeft += event.deltaX;
      }

      event.preventDefault();
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className ? `milkdown-editor ${className}` : "milkdown-editor"}
    >
      <Milkdown />
    </div>
  );
}

export function MilkdownEditor({ value, onChange, className }: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner value={value} onChange={onChange} className={className} />
    </MilkdownProvider>
  );
}
