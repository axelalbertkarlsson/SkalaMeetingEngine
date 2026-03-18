import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { editorViewCtx, prosePluginsCtx } from "@milkdown/core";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import { Fragment, type Node as ProseMirrorNode } from "@milkdown/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { createSpellcheckPlugin, clearSpellcheckDecorations, getSpellcheckRangeAtPos, updateSpellcheckDecorations } from "../../lib/spellcheck/spellcheckPlugin";
import { collectSpellcheckTokens } from "../../lib/spellcheck/spellcheckTokenizer";
import { SpellcheckWorkerClient } from "../../lib/spellcheck/spellcheckWorkerClient";
import type { PersonalDictionary, SpellcheckRange } from "../../models/spellcheck";
import { addPersonalDictionaryWord, loadPersonalDictionary } from "../../services/spellcheckDictionaryStore";

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

interface SpellcheckContextMenuState {
  x: number;
  y: number;
  range: SpellcheckRange;
}

function createEmptyPersonalDictionary(): PersonalDictionary {
  return {
    version: 1,
    words: []
  };
}

function applySuggestionCase(originalWord: string, suggestion: string) {
  if (originalWord === originalWord.toUpperCase()) {
    return suggestion.toUpperCase();
  }

  const [firstCharacter = "", ...restCharacters] = originalWord;
  const rest = restCharacters.join("");

  if (firstCharacter === firstCharacter.toUpperCase() && rest === rest.toLowerCase()) {
    return suggestion.charAt(0).toUpperCase() + suggestion.slice(1);
  }

  return suggestion;
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
  const editorViewRef = useRef<EditorView | null>(null);
  const spellcheckWorkerRef = useRef<SpellcheckWorkerClient | null>(null);
  const spellcheckTimeoutRef = useRef<number | null>(null);
  const spellcheckDocVersionRef = useRef(0);
  const personalDictionaryRef = useRef<PersonalDictionary>(createEmptyPersonalDictionary());
  const spellcheckMenuRef = useRef<HTMLDivElement | null>(null);
  const [spellcheckMenu, setSpellcheckMenu] = useState<SpellcheckContextMenuState | null>(null);

  const closeSpellcheckMenu = () => {
    setSpellcheckMenu(null);
  };

  const scheduleSpellcheck = (doc: ProseMirrorNode) => {
    if (typeof window === "undefined") {
      return;
    }

    if (spellcheckTimeoutRef.current !== null) {
      window.clearTimeout(spellcheckTimeoutRef.current);
    }

    spellcheckTimeoutRef.current = window.setTimeout(() => {
      spellcheckTimeoutRef.current = null;

      const worker = spellcheckWorkerRef.current;
      const view = editorViewRef.current;
      if (!worker || !view) {
        return;
      }

      const tokens = collectSpellcheckTokens(doc);
      const docVersion = spellcheckDocVersionRef.current + 1;
      spellcheckDocVersionRef.current = docVersion;
      worker.checkTokens(docVersion, tokens);
    }, 250);
  };

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
      ctx.update(prosePluginsCtx, (plugins) => plugins.concat(createSpellcheckPlugin()));

      const listeners = ctx.get(listenerCtx);
      listeners
        .mounted((mountedCtx) => {
          const view = mountedCtx.get(editorViewCtx);
          editorViewRef.current = view;
          view.dom.spellcheck = false;
          view.dom.setAttribute("spellcheck", "false");
          scheduleSpellcheck(view.state.doc);
        })
        .updated((updatedCtx, doc) => {
          editorViewRef.current = updatedCtx.get(editorViewCtx);
          scheduleSpellcheck(doc);
        })
        .markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        })
        .destroy(() => {
          editorViewRef.current = null;
          closeSpellcheckMenu();
        });
    });

    return crepe;
  }, []);

  useEffect(() => {
    const worker = new SpellcheckWorkerClient((update) => {
      if (update.docVersion !== spellcheckDocVersionRef.current) {
        return;
      }

      const view = editorViewRef.current;
      if (!view) {
        return;
      }

      updateSpellcheckDecorations(view, update.ranges);
      setSpellcheckMenu((current) => {
        if (!current) {
          return current;
        }

        const matchingRange = update.ranges.find(
          (range) => range.from === current.range.from && range.to === current.range.to && range.word === current.range.word
        );

        if (!matchingRange) {
          return null;
        }

        return {
          ...current,
          range: matchingRange
        };
      });
    });

    spellcheckWorkerRef.current = worker;
    worker.setPersonalDictionary(personalDictionaryRef.current.words);

    void loadPersonalDictionary()
      .then((dictionary) => {
        personalDictionaryRef.current = dictionary;
        worker.setPersonalDictionary(dictionary.words);

        const view = editorViewRef.current;
        if (view) {
          scheduleSpellcheck(view.state.doc);
        }
      })
      .catch((error) => {
        console.error("[spellcheck] Failed to initialize dictionary", error);
      });

    return () => {
      if (spellcheckTimeoutRef.current !== null) {
        window.clearTimeout(spellcheckTimeoutRef.current);
        spellcheckTimeoutRef.current = null;
      }

      const view = editorViewRef.current;
      if (view) {
        clearSpellcheckDecorations(view);
      }

      spellcheckWorkerRef.current = null;
      worker.dispose();
    };
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

      const view = crepe.editor.ctx.get(editorViewCtx);
      editorViewRef.current = view;
      return view;
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !container.contains(target)) {
        closeSpellcheckMenu();
        return;
      }

      const view = editorViewRef.current;
      if (!view) {
        closeSpellcheckMenu();
        return;
      }

      const resolvedPosition = view.posAtCoords({
        left: event.clientX,
        top: event.clientY
      });

      if (!resolvedPosition) {
        closeSpellcheckMenu();
        return;
      }

      const range = getSpellcheckRangeAtPos(view.state, resolvedPosition.pos);
      if (!range) {
        closeSpellcheckMenu();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      setSpellcheckMenu({
        x: event.clientX,
        y: event.clientY,
        range
      });
    };

    container.addEventListener("contextmenu", onContextMenu);
    return () => {
      container.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  useEffect(() => {
    if (!spellcheckMenu) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && spellcheckMenuRef.current?.contains(target)) {
        return;
      }

      closeSpellcheckMenu();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSpellcheckMenu();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [spellcheckMenu]);

  const replaceMisspelledWord = (range: SpellcheckRange, suggestion: string) => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const replacement = applySuggestionCase(range.word, suggestion);

    try {
      const transaction = view.state.tr.insertText(replacement, range.from, range.to);
      view.dispatch(transaction.scrollIntoView());
      scheduleSpellcheck(view.state.doc);
      view.focus();
      closeSpellcheckMenu();
    } catch (error) {
      console.error("[spellcheck] Failed to replace misspelled word", { range, suggestion, error });
    }
  };

  const addWordToDictionary = async (range: SpellcheckRange) => {
    closeSpellcheckMenu();

    try {
      const dictionary = await addPersonalDictionaryWord(range.word);
      personalDictionaryRef.current = dictionary;
      spellcheckWorkerRef.current?.setPersonalDictionary(dictionary.words);

      const view = editorViewRef.current;
      if (view) {
        scheduleSpellcheck(view.state.doc);
      }
    } catch (error) {
      console.error("[spellcheck] Failed to add word to dictionary", { range, error });
    }
  };

  const spellcheckMenuOverlay = spellcheckMenu && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={spellcheckMenuRef}
          className="documents-context-menu spellcheck-context-menu"
          style={{
            left: `${Math.max(8, Math.min(spellcheckMenu.x, window.innerWidth - 240))}px`,
            top: `${Math.max(8, Math.min(spellcheckMenu.y, window.innerHeight - 240))}px`
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {spellcheckMenu.range.suggestions.length > 0 ? (
            spellcheckMenu.range.suggestions.map((suggestion) => (
              <button
                key={`${spellcheckMenu.range.from}-${suggestion}`}
                type="button"
                className="documents-context-menu-item"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  replaceMisspelledWord(spellcheckMenu.range, suggestion);
                }}
              >
                {applySuggestionCase(spellcheckMenu.range.word, suggestion)}
              </button>
            ))
          ) : (
            <button type="button" className="documents-context-menu-item" disabled>
              No suggestions
            </button>
          )}
          <div className="documents-context-menu-separator" />
          <button
            type="button"
            className="documents-context-menu-item"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void addWordToDictionary(spellcheckMenu.range);
            }}
          >
            Add to dictionary
          </button>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <div
        ref={containerRef}
        className={className ? `milkdown-editor ${className}` : "milkdown-editor"}
      >
        <Milkdown />
      </div>
      {spellcheckMenuOverlay}
    </>
  );
}

export function MilkdownEditor({ value, onChange, className }: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner value={value} onChange={onChange} className={className} />
    </MilkdownProvider>
  );
}