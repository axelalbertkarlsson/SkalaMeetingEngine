import { useEffect, useRef } from "react";
import { editorViewCtx } from "@milkdown/core";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import { Fragment, type Node as ProseMirrorNode } from "@milkdown/prose/model";
import { NodeSelection } from "@milkdown/prose/state";
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

function moveSelectedBlock(view: EditorView, direction: "up" | "down"): boolean {
  const { state } = view;
  const { doc, selection } = state;

  if (doc.childCount < 2) {
    return false;
  }

  const currentIndex = selection.$from.index(0);
  const targetIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;

  if (currentIndex < 0 || currentIndex >= doc.childCount || targetIndex < 0 || targetIndex >= doc.childCount) {
    return false;
  }

  const firstIndex = Math.min(currentIndex, targetIndex);
  const secondIndex = firstIndex + 1;

  const firstNode = doc.child(firstIndex);
  const secondNode = doc.child(secondIndex);

  const replaceFrom = posAtChildIndex(doc, firstIndex);
  const replaceTo = replaceFrom + firstNode.nodeSize + secondNode.nodeSize;

  let tr = state.tr.replaceWith(replaceFrom, replaceTo, Fragment.fromArray([secondNode, firstNode]));

  const movedIndex = direction === "down" ? currentIndex + 1 : currentIndex - 1;
  const movedPos = posAtChildIndex(tr.doc, movedIndex);
  tr = tr.setSelection(NodeSelection.create(tr.doc, movedPos));

  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function syncSelectionToHandle(view: EditorView, handleElement: HTMLElement) {
  const editorRect = view.dom.getBoundingClientRect();
  const handleRect = handleElement.getBoundingClientRect();

  const probeX = Math.min(editorRect.left + 24, editorRect.right - 1);
  const probeY = Math.min(Math.max(handleRect.top + handleRect.height / 2, editorRect.top + 1), editorRect.bottom - 1);

  const resolved = view.posAtCoords({
    left: probeX,
    top: probeY
  });

  if (!resolved || resolved.inside == null || resolved.inside < 0) {
    return;
  }

  const currentDoc = view.state.doc;
  const $pos = currentDoc.resolve(resolved.inside);
  const blockIndex = Math.min($pos.index(0), currentDoc.childCount - 1);
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

    let activePointerId: number | null = null;
    let activeDragItem: HTMLElement | null = null;
    let lastPointerY = 0;
    let pendingDeltaY = 0;
    const stepThreshold = 28;

    const clearActiveDragState = () => {
      if (activeDragItem) {
        activeDragItem.classList.remove("active");
      }
      activeDragItem = null;
      activePointerId = null;
      pendingDeltaY = 0;
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const dragItem = target.closest(".milkdown-block-handle .operation-item:last-child");
      if (!(dragItem instanceof HTMLElement) || !container.contains(dragItem)) {
        return;
      }

      const view = getView();
      if (!view) {
        return;
      }

      syncSelectionToHandle(view, dragItem);

      activePointerId = event.pointerId;
      activeDragItem = dragItem;
      lastPointerY = event.clientY;
      pendingDeltaY = 0;

      dragItem.classList.add("active");
      dragItem.setPointerCapture(event.pointerId);

      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (activePointerId == null || event.pointerId !== activePointerId) {
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

    const onPointerUp = (event: PointerEvent) => {
      if (activePointerId == null || event.pointerId !== activePointerId) {
        return;
      }

      clearActiveDragState();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activePointerId == null || event.pointerId !== activePointerId) {
        return;
      }

      clearActiveDragState();
    };

    container.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);

    return () => {
      clearActiveDragState();
      container.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
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
