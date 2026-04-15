import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { computeDocumentGraphLayout } from "../../lib/documentsLinks";
import type { DocumentsIndex } from "../../models/documents";

interface ViewBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DocumentsGraphViewProps {
  activeNoteId?: string;
  documentsIndex: DocumentsIndex;
  onOpenNote: (noteId: string) => void;
}

function createDefaultViewBox(): ViewBoxState {
  return {
    x: -420,
    y: -320,
    width: 840,
    height: 640
  };
}

export function DocumentsGraphView({
  activeNoteId,
  documentsIndex,
  onOpenNote
}: DocumentsGraphViewProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startViewBox: ViewBoxState;
  } | null>(null);
  const [viewBox, setViewBox] = useState<ViewBoxState>(createDefaultViewBox);

  const layoutNodes = useMemo(
    () => computeDocumentGraphLayout(documentsIndex.graphNodes, documentsIndex.graphEdges),
    [documentsIndex.graphEdges, documentsIndex.graphNodes]
  );
  const layoutNodeById = useMemo(
    () => new Map(layoutNodes.map((node) => [node.id, node])),
    [layoutNodes]
  );

  const getNodeRadius = (nodeId: string) => {
    const node = layoutNodeById.get(nodeId);
    if (!node) {
      return 20;
    }

    if (node.kind === "dangling") {
      return 18;
    }

    return node.noteId !== null && node.noteId === activeNoteId ? 22 : 20;
  };

  useEffect(() => {
    if (layoutNodes.length === 0) {
      setViewBox(createDefaultViewBox());
      return;
    }

    const bounds = layoutNodes.reduce(
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

    const padding = 180;
    setViewBox({
      x: bounds.minX - padding,
      y: bounds.minY - padding,
      width: Math.max(560, bounds.maxX - bounds.minX + padding * 2),
      height: Math.max(420, bounds.maxY - bounds.minY + padding * 2)
    });
  }, [layoutNodes]);

  const beginDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !svgRef.current) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startViewBox: viewBox
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const dragState = dragStateRef.current;
    const svg = svgRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !svg) {
      return;
    }

    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const deltaX = ((event.clientX - dragState.originX) / rect.width) * dragState.startViewBox.width;
    const deltaY = ((event.clientY - dragState.originY) / rect.height) * dragState.startViewBox.height;

    setViewBox({
      ...dragState.startViewBox,
      x: dragState.startViewBox.x - deltaX,
      y: dragState.startViewBox.y - deltaY
    });
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
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

    const zoomFactor = event.deltaY > 0 ? 1.12 : 0.9;
    const nextWidth = Math.max(240, Math.min(3200, viewBox.width * zoomFactor));
    const nextHeight = Math.max(180, Math.min(2400, viewBox.height * zoomFactor));
    const pointerRatioX = (event.clientX - rect.left) / rect.width;
    const pointerRatioY = (event.clientY - rect.top) / rect.height;
    const pointerWorldX = viewBox.x + viewBox.width * pointerRatioX;
    const pointerWorldY = viewBox.y + viewBox.height * pointerRatioY;

    setViewBox({
      x: pointerWorldX - nextWidth * pointerRatioX,
      y: pointerWorldY - nextHeight * pointerRatioY,
      width: nextWidth,
      height: nextHeight
    });
  };

  if (layoutNodes.length === 0) {
    return (
      <div className="documents-graph-empty">
        <p className="muted">No notes or links available yet.</p>
      </div>
    );
  }

  return (
    <div className="documents-graph-root">
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
        onPointerDown={beginDrag}
        onPointerMove={updateDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
            const sourceRadius = getNodeRadius(edge.source);
            const targetRadius = getNodeRadius(edge.target);
            const sourceOffset = sourceRadius + 2;
            const targetOffset = targetRadius + 2;
            const x1 = sourceNode.x + (dx / distance) * sourceOffset;
            const y1 = sourceNode.y + (dy / distance) * sourceOffset;
            const x2 = targetNode.x - (dx / distance) * targetOffset;
            const y2 = targetNode.y - (dy / distance) * targetOffset;

            return (
              <line
                key={edge.id}
                className={edge.isDangling ? "documents-graph-edge dangling" : "documents-graph-edge"}
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
            const radius = node.kind === "dangling" ? 18 : isActive ? 22 : 20;
            const canOpen = node.noteId !== null;

            return (
              <g
                key={node.id}
                className={[
                  "documents-graph-node",
                  node.kind === "dangling" ? "dangling" : "",
                  isActive ? "active" : "",
                  canOpen ? "clickable" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                transform={`translate(${node.x} ${node.y})`}
                onClick={() => {
                  if (node.noteId) {
                    onOpenNote(node.noteId);
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
