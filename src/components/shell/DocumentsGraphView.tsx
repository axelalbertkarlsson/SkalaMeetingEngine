import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  cleanupDocumentGraphPinnedPositions,
  computeDocumentGraphLayout,
  getDocumentGraphFocus
} from "../../lib/documentsLinks";
import type {
  DocumentGraphLayoutNode,
  DocumentGraphPinnedPositions,
  DocumentsIndex
} from "../../models/documents";

interface ViewBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DocumentsGraphViewProps {
  activeNoteId?: string;
  documentsIndex: DocumentsIndex;
  layoutStorageKey: string;
  onOpenNote: (noteId: string) => void;
}

const nodeDragHoldDelayMs = 150;
const nodePointerMoveThreshold = 6;

function createDefaultViewBox(): ViewBoxState {
  return {
    x: -420,
    y: -320,
    width: 840,
    height: 640
  };
}

function readGraphPinnedPositions(layoutStorageKey: string): DocumentGraphPinnedPositions {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = window.localStorage.getItem(layoutStorageKey);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, { x?: unknown; y?: unknown }>;
    const nextPinnedPositions: DocumentGraphPinnedPositions = {};

    Object.entries(parsed).forEach(([nodeId, point]) => {
      if (typeof point?.x !== "number" || typeof point?.y !== "number") {
        return;
      }

      nextPinnedPositions[nodeId] = {
        x: point.x,
        y: point.y
      };
    });

    return nextPinnedPositions;
  } catch {
    return {};
  }
}

function arePinnedPositionsEqual(
  first: DocumentGraphPinnedPositions,
  second: DocumentGraphPinnedPositions
) {
  const firstEntries = Object.entries(first);
  const secondEntries = Object.entries(second);
  if (firstEntries.length !== secondEntries.length) {
    return false;
  }

  return firstEntries.every(([nodeId, point]) => {
    const otherPoint = second[nodeId];
    return otherPoint != null && otherPoint.x === point.x && otherPoint.y === point.y;
  });
}

function createGraphBounds(nodes: DocumentGraphLayoutNode[]) {
  return nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.x),
      maxX: Math.max(accumulator.maxX, node.x),
      minY: Math.min(accumulator.minY, node.y),
      maxY: Math.max(accumulator.maxY, node.y)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  );
}

export function DocumentsGraphView({
  activeNoteId,
  documentsIndex,
  layoutStorageKey,
  onOpenNote
}: DocumentsGraphViewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewBoxRef = useRef<ViewBoxState>(createDefaultViewBox());
  const pinnedPositionsRef = useRef<DocumentGraphPinnedPositions>(readGraphPinnedPositions(layoutStorageKey));
  const panStateRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startViewBox: ViewBoxState;
  } | null>(null);
  const nodeInteractionRef = useRef<{
    pointerId: number;
    nodeId: string;
    noteId: string | null;
    originX: number;
    originY: number;
    offsetX: number;
    offsetY: number;
    isDragging: boolean;
    hasMoved: boolean;
    holdTimeoutId: number | null;
  } | null>(null);
  const graphStructureKeyRef = useRef<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBoxState>(createDefaultViewBox);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [pinnedPositions, setPinnedPositions] = useState<DocumentGraphPinnedPositions>(() =>
    readGraphPinnedPositions(layoutStorageKey)
  );

  const persistPinnedPositions = useCallback(
    (nextPinnedPositions: DocumentGraphPinnedPositions) => {
      if (typeof window === "undefined") {
        return;
      }

      window.localStorage.setItem(layoutStorageKey, JSON.stringify(nextPinnedPositions));
    },
    [layoutStorageKey]
  );

  useEffect(() => {
    pinnedPositionsRef.current = pinnedPositions;
  }, [pinnedPositions]);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  useEffect(() => {
    const nodeIds = documentsIndex.graphNodes.map((node) => node.id);
    setPinnedPositions((current) => {
      const next = cleanupDocumentGraphPinnedPositions(current, nodeIds);
      if (arePinnedPositionsEqual(current, next)) {
        return current;
      }

      pinnedPositionsRef.current = next;
      persistPinnedPositions(next);
      return next;
    });
  }, [documentsIndex.graphNodes, persistPinnedPositions]);

  const layoutNodes = useMemo(
    () =>
      computeDocumentGraphLayout(documentsIndex.graphNodes, documentsIndex.graphEdges, {
        pinnedPositions
      }),
    [documentsIndex.graphEdges, documentsIndex.graphNodes, pinnedPositions]
  );
  const layoutNodeById = useMemo(
    () => new Map(layoutNodes.map((node) => [node.id, node])),
    [layoutNodes]
  );
  const focusSet = useMemo(
    () => (hoveredNodeId ? getDocumentGraphFocus(hoveredNodeId, documentsIndex.graphEdges) : null),
    [documentsIndex.graphEdges, hoveredNodeId]
  );
  const focusNodeIds = useMemo(() => new Set(focusSet?.nodeIds ?? []), [focusSet]);
  const focusEdgeIds = useMemo(() => new Set(focusSet?.edgeIds ?? []), [focusSet]);
  const nodeRadiusById = useMemo(() => {
    const radiusById = new Map<string, number>();

    layoutNodes.forEach((node) => {
      let radius = node.kind === "dangling" ? 18 : node.noteId !== null && node.noteId === activeNoteId ? 22 : 20;

      if (hoveredNodeId === node.id) {
        radius += 4;
      } else if (hoveredNodeId && focusNodeIds.has(node.id)) {
        radius += 2;
      }

      if (draggedNodeId === node.id) {
        radius += 2;
      }

      radiusById.set(node.id, radius);
    });

    return radiusById;
  }, [activeNoteId, draggedNodeId, focusNodeIds, hoveredNodeId, layoutNodes]);
  const graphStructureKey = useMemo(
    () =>
      JSON.stringify({
        nodeIds: documentsIndex.graphNodes.map((node) => node.id),
        edgeIds: documentsIndex.graphEdges.map((edge) => edge.id)
      }),
    [documentsIndex.graphEdges, documentsIndex.graphNodes]
  );

  useEffect(() => {
    if (layoutNodes.length === 0) {
      graphStructureKeyRef.current = graphStructureKey;
      setViewBox(createDefaultViewBox());
      return;
    }

    if (graphStructureKeyRef.current === graphStructureKey) {
      return;
    }

    graphStructureKeyRef.current = graphStructureKey;
    const bounds = createGraphBounds(layoutNodes);
    const padding = 180;
    setViewBox({
      x: bounds.minX - padding,
      y: bounds.minY - padding,
      width: Math.max(560, bounds.maxX - bounds.minX + padding * 2),
      height: Math.max(420, bounds.maxY - bounds.minY + padding * 2)
    });
  }, [graphStructureKey, layoutNodes]);

  const clientToWorldPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const currentViewBox = viewBoxRef.current;
    return {
      x: currentViewBox.x + ((clientX - rect.left) / rect.width) * currentViewBox.width,
      y: currentViewBox.y + ((clientY - rect.top) / rect.height) * currentViewBox.height
    };
  }, []);

  const updatePinnedNodePosition = useCallback((nodeId: string, x: number, y: number) => {
    setPinnedPositions((current) => {
      const existingPoint = current[nodeId];
      if (existingPoint && existingPoint.x === x && existingPoint.y === y) {
        return current;
      }

      const next = {
        ...current,
        [nodeId]: { x, y }
      };
      pinnedPositionsRef.current = next;
      return next;
    });
  }, []);

  const clearNodeInteraction = useCallback(
    (persistLayout: boolean) => {
      const interaction = nodeInteractionRef.current;
      if (!interaction) {
        return;
      }

      if (typeof interaction.holdTimeoutId === "number") {
        window.clearTimeout(interaction.holdTimeoutId);
      }

      if (persistLayout && interaction.isDragging) {
        persistPinnedPositions(pinnedPositionsRef.current);
      }

      nodeInteractionRef.current = null;
      setDraggedNodeId(null);
    },
    [persistPinnedPositions]
  );

  useEffect(() => {
    return () => {
      clearNodeInteraction(true);
    };
  }, [clearNodeInteraction]);

  const beginCanvasPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !svgRef.current) {
      return;
    }

    panStateRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startViewBox: viewBoxRef.current
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateCanvasPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const panState = panStateRef.current;
    const svg = svgRef.current;
    if (!panState || panState.pointerId !== event.pointerId || !svg) {
      return;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const deltaX = ((event.clientX - panState.originX) / rect.width) * panState.startViewBox.width;
    const deltaY = ((event.clientY - panState.originY) / rect.height) * panState.startViewBox.height;

    setViewBox({
      ...panState.startViewBox,
      x: panState.startViewBox.x - deltaX,
      y: panState.startViewBox.y - deltaY
    });
  };

  const endCanvasPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (panStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    panStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();

    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const currentViewBox = viewBoxRef.current;
    const zoomFactor = event.deltaY > 0 ? 1.12 : 0.9;
    const nextWidth = Math.max(240, Math.min(3200, currentViewBox.width * zoomFactor));
    const nextHeight = Math.max(180, Math.min(2400, currentViewBox.height * zoomFactor));
    const pointerRatioX = (event.clientX - rect.left) / rect.width;
    const pointerRatioY = (event.clientY - rect.top) / rect.height;
    const pointerWorldX = currentViewBox.x + currentViewBox.width * pointerRatioX;
    const pointerWorldY = currentViewBox.y + currentViewBox.height * pointerRatioY;

    setViewBox({
      x: pointerWorldX - nextWidth * pointerRatioX,
      y: pointerWorldY - nextHeight * pointerRatioY,
      width: nextWidth,
      height: nextHeight
    });
  };

  const beginNodeInteraction = (event: ReactPointerEvent<SVGGElement>, node: DocumentGraphLayoutNode) => {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    const pointerWorldPoint = clientToWorldPoint(event.clientX, event.clientY);
    if (!pointerWorldPoint) {
      return;
    }

    const holdTimeoutId = window.setTimeout(() => {
      const interaction = nodeInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) {
        return;
      }

      interaction.isDragging = true;
      setDraggedNodeId(node.id);
      setHoveredNodeId(node.id);
      updatePinnedNodePosition(node.id, node.x, node.y);
    }, nodeDragHoldDelayMs);

    nodeInteractionRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      noteId: node.noteId,
      originX: event.clientX,
      originY: event.clientY,
      offsetX: pointerWorldPoint.x - node.x,
      offsetY: pointerWorldPoint.y - node.y,
      isDragging: false,
      hasMoved: false,
      holdTimeoutId
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    setHoveredNodeId(node.id);
  };

  const updateNodeInteraction = (event: ReactPointerEvent<SVGGElement>) => {
    const interaction = nodeInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    const movement = Math.hypot(event.clientX - interaction.originX, event.clientY - interaction.originY);
    if (movement >= nodePointerMoveThreshold) {
      interaction.hasMoved = true;
    }

    if (!interaction.isDragging) {
      return;
    }

    const pointerWorldPoint = clientToWorldPoint(event.clientX, event.clientY);
    if (!pointerWorldPoint) {
      return;
    }

    updatePinnedNodePosition(
      interaction.nodeId,
      pointerWorldPoint.x - interaction.offsetX,
      pointerWorldPoint.y - interaction.offsetY
    );
    setHoveredNodeId(interaction.nodeId);
  };

  const endNodeInteraction = (event: ReactPointerEvent<SVGGElement>) => {
    const interaction = nodeInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);

    const shouldOpenNote = !interaction.isDragging && !interaction.hasMoved && interaction.noteId !== null;
    clearNodeInteraction(true);

    if (shouldOpenNote) {
      onOpenNote(interaction.noteId!);
    }
  };

  const cancelNodeInteraction = (event: ReactPointerEvent<SVGGElement>) => {
    const interaction = nodeInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    clearNodeInteraction(true);
  };

  if (layoutNodes.length === 0) {
    return (
      <div className="documents-graph-empty">
        <p className="muted">No notes or links available yet.</p>
      </div>
    );
  }

  return (
    <div
      className={[
        "documents-graph-root",
        hoveredNodeId ? "has-focus" : "",
        draggedNodeId ? "dragging-node" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="documents-graph-status">
        <span>
          {documentsIndex.graphNodes.length} notes, {documentsIndex.graphEdges.length} links
        </span>
        {documentsIndex.graphEdges.length === 0 ? (
          <span className="muted">
            No wiki-links detected yet. Add links like <code>[[Another note]]</code> inside your notes.
          </span>
        ) : null}
      </div>
      <svg
        ref={svgRef}
        className="documents-graph-canvas"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        onPointerDown={beginCanvasPan}
        onPointerMove={updateCanvasPan}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onPointerLeave={() => {
          if (!nodeInteractionRef.current) {
            setHoveredNodeId(null);
          }
        }}
        onWheel={handleWheel}
        role="img"
        aria-label="Documents link graph"
      >
        <rect
          className="documents-graph-background"
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.width}
          height={viewBox.height}
        />

        <g className="documents-graph-edges" aria-hidden="true">
          {documentsIndex.graphEdges.map((edge) => {
            const sourceNode = layoutNodeById.get(edge.source);
            const targetNode = layoutNodeById.get(edge.target);
            if (!sourceNode || !targetNode) {
              return null;
            }

            const dx = targetNode.x - sourceNode.x;
            const dy = targetNode.y - sourceNode.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const sourceRadius = nodeRadiusById.get(edge.source) ?? 20;
            const targetRadius = nodeRadiusById.get(edge.target) ?? 20;
            const sourceOffset = sourceRadius + 2;
            const targetOffset = targetRadius + 2;
            const x1 = sourceNode.x + (dx / distance) * sourceOffset;
            const y1 = sourceNode.y + (dy / distance) * sourceOffset;
            const x2 = targetNode.x - (dx / distance) * targetOffset;
            const y2 = targetNode.y - (dy / distance) * targetOffset;
            const edgeClassName = [
              "documents-graph-edge",
              edge.isDangling ? "dangling" : "",
              hoveredNodeId ? (focusEdgeIds.has(edge.id) ? "related" : "dimmed") : ""
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <line
                key={edge.id}
                className={edgeClassName}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                strokeWidth={Math.min(4, 1 + edge.count * 0.45)}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>

        <g className="documents-graph-nodes">
          {layoutNodes.map((node) => {
            const isActive = node.noteId !== null && node.noteId === activeNoteId;
            const isFocused = hoveredNodeId === node.id;
            const isRelated = hoveredNodeId !== null && !isFocused && focusNodeIds.has(node.id);
            const canOpen = node.noteId !== null;
            const radius = nodeRadiusById.get(node.id) ?? 20;

            return (
              <g
                key={node.id}
                className={[
                  "documents-graph-node",
                  node.kind === "dangling" ? "dangling" : "",
                  isActive ? "active" : "",
                  isFocused ? "focused" : "",
                  isRelated ? "related" : "",
                  hoveredNodeId !== null && !focusNodeIds.has(node.id) ? "dimmed" : "",
                  draggedNodeId === node.id ? "dragging" : "",
                  canOpen ? "clickable" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => beginNodeInteraction(event, node)}
                onPointerMove={updateNodeInteraction}
                onPointerUp={endNodeInteraction}
                onPointerCancel={cancelNodeInteraction}
                onPointerEnter={() => setHoveredNodeId(node.id)}
                onPointerLeave={() => {
                  if (draggedNodeId !== node.id) {
                    setHoveredNodeId((current) => (current === node.id ? null : current));
                  }
                }}
              >
                <circle r={radius} />
                <text y={radius + 18} textAnchor="middle">
                  {node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
