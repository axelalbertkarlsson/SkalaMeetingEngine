import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  clampDocumentGraphForceSettings,
  createDocumentGraphSimulationNodes,
  createPinnedPositionsFromSimulationNodes,
  defaultDocumentGraphForceSettings,
  documentGraphForceSliderRange,
  stepDocumentGraphSimulation,
  type DocumentGraphForceSettings,
  type DocumentGraphSimulationNode
} from "../../lib/documentGraphSimulation";
import {
  cleanupDocumentGraphPinnedPositions,
  computeDocumentGraphLayout,
  getDocumentGraphFocus
} from "../../lib/documentsLinks";
import type {
  DocumentGraphLayoutNode,
  DocumentGraphPinnedPositions,
  DocumentGraphPoint,
  DocumentsIndex
} from "../../models/documents";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GearIcon,
  ResetIcon,
  WindowCloseIcon
} from "./icons";

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

type DocumentGraphForceSettingKey = keyof DocumentGraphForceSettings;

const nodePointerMoveThreshold = 6;
const simulationStopAlpha = 0.012;
const simulationAlphaDecay = 0.92;
const dragSimulationAlpha = 0.72;
const forceControls: Array<{ key: DocumentGraphForceSettingKey; label: string }> = [
  { key: "centerForce", label: "Center force" },
  { key: "repelForce", label: "Repel force" },
  { key: "linkForce", label: "Link force" },
  { key: "linkDistance", label: "Link distance" }
];

function createDefaultViewBox(): ViewBoxState {
  return {
    x: -420,
    y: -320,
    width: 840,
    height: 640
  };
}

function getGraphForceSettingsStorageKey(layoutStorageKey: string) {
  return `${layoutStorageKey}.forces`;
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

function readGraphForceSettings(forceSettingsStorageKey: string): DocumentGraphForceSettings {
  if (typeof window === "undefined") {
    return defaultDocumentGraphForceSettings;
  }

  const raw = window.localStorage.getItem(forceSettingsStorageKey);
  if (!raw) {
    return defaultDocumentGraphForceSettings;
  }

  try {
    return clampDocumentGraphForceSettings(JSON.parse(raw) as Partial<DocumentGraphForceSettings>);
  } catch {
    return defaultDocumentGraphForceSettings;
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

function areForceSettingsEqual(first: DocumentGraphForceSettings, second: DocumentGraphForceSettings) {
  return (
    first.centerForce === second.centerForce &&
    first.repelForce === second.repelForce &&
    first.linkForce === second.linkForce &&
    first.linkDistance === second.linkDistance
  );
}

function createGraphBounds(nodes: Array<Pick<DocumentGraphLayoutNode, "x" | "y">>) {
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

function transformClientPoint(clientX: number, clientY: number, screenToWorldTransform: DOMMatrix) {
  const point = new DOMPoint(clientX, clientY).matrixTransform(screenToWorldTransform);
  return {
    x: point.x,
    y: point.y
  };
}

function createViewBoxForNodes(nodes: Array<Pick<DocumentGraphLayoutNode, "x" | "y">>) {
  if (nodes.length === 0) {
    return createDefaultViewBox();
  }

  const bounds = createGraphBounds(nodes);
  const padding = 180;
  return {
    x: bounds.minX - padding,
    y: bounds.minY - padding,
    width: Math.max(560, bounds.maxX - bounds.minX + padding * 2),
    height: Math.max(420, bounds.maxY - bounds.minY + padding * 2)
  };
}

export function DocumentsGraphView({
  activeNoteId,
  documentsIndex,
  layoutStorageKey,
  onOpenNote
}: DocumentsGraphViewProps) {
  const forceSettingsStorageKey = useMemo(
    () => getGraphForceSettingsStorageKey(layoutStorageKey),
    [layoutStorageKey]
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewBoxRef = useRef<ViewBoxState>(createDefaultViewBox());
  const pinnedPositionsRef = useRef<DocumentGraphPinnedPositions>(readGraphPinnedPositions(layoutStorageKey));
  const forceSettingsRef = useRef<DocumentGraphForceSettings>(readGraphForceSettings(forceSettingsStorageKey));
  const graphEdgesRef = useRef(documentsIndex.graphEdges);
  const nodeRadiusByIdRef = useRef<Map<string, number>>(new Map());
  const simulationNodesRef = useRef<DocumentGraphSimulationNode[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const simulationAlphaRef = useRef(0);
  const saveSimulationPositionsRef = useRef<(nodes: DocumentGraphSimulationNode[]) => void>(() => {});
  const scheduleSimulationRef = useRef<() => void>(() => {});
  const panStateRef = useRef<{
    pointerId: number;
    originPoint: DocumentGraphPoint;
    screenToWorldTransform: DOMMatrix;
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
    currentX: number;
    currentY: number;
    isDragging: boolean;
    hasMoved: boolean;
  } | null>(null);
  const graphStructureKeyRef = useRef<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBoxState>(createDefaultViewBox);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [controlsPanelOpen, setControlsPanelOpen] = useState(true);
  const [layoutResetVersion, setLayoutResetVersion] = useState(0);
  const [forceSettings, setForceSettings] = useState<DocumentGraphForceSettings>(() =>
    readGraphForceSettings(forceSettingsStorageKey)
  );
  const [pinnedPositions, setPinnedPositions] = useState<DocumentGraphPinnedPositions>(() =>
    readGraphPinnedPositions(layoutStorageKey)
  );

  const persistPinnedPositions = useCallback(
    (nextPinnedPositions: DocumentGraphPinnedPositions) => {
      if (typeof window === "undefined") {
        return;
      }

      if (Object.keys(nextPinnedPositions).length === 0) {
        window.localStorage.removeItem(layoutStorageKey);
        return;
      }

      window.localStorage.setItem(layoutStorageKey, JSON.stringify(nextPinnedPositions));
    },
    [layoutStorageKey]
  );

  const persistForceSettings = useCallback(
    (nextForceSettings: DocumentGraphForceSettings) => {
      if (typeof window === "undefined") {
        return;
      }

      if (areForceSettingsEqual(nextForceSettings, defaultDocumentGraphForceSettings)) {
        window.localStorage.removeItem(forceSettingsStorageKey);
        return;
      }

      window.localStorage.setItem(forceSettingsStorageKey, JSON.stringify(nextForceSettings));
    },
    [forceSettingsStorageKey]
  );

  useEffect(() => {
    pinnedPositionsRef.current = pinnedPositions;
  }, [pinnedPositions]);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  useEffect(() => {
    forceSettingsRef.current = forceSettings;
    persistForceSettings(forceSettings);
  }, [forceSettings, persistForceSettings]);

  useEffect(() => {
    graphEdgesRef.current = documentsIndex.graphEdges;
  }, [documentsIndex.graphEdges]);

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
  const [simulationNodes, setSimulationNodes] = useState<DocumentGraphSimulationNode[]>(() =>
    createDocumentGraphSimulationNodes(layoutNodes)
  );
  const renderedNodes: DocumentGraphLayoutNode[] = simulationNodes.length > 0 ? simulationNodes : layoutNodes;
  const layoutNodeById = useMemo(
    () => new Map(renderedNodes.map((node) => [node.id, node])),
    [renderedNodes]
  );
  const focusSet = useMemo(
    () => (hoveredNodeId ? getDocumentGraphFocus(hoveredNodeId, documentsIndex.graphEdges) : null),
    [documentsIndex.graphEdges, hoveredNodeId]
  );
  const focusNodeIds = useMemo(() => new Set(focusSet?.nodeIds ?? []), [focusSet]);
  const focusEdgeIds = useMemo(() => new Set(focusSet?.edgeIds ?? []), [focusSet]);
  const nodeRadiusById = useMemo(() => {
    const radiusById = new Map<string, number>();

    renderedNodes.forEach((node) => {
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
  }, [activeNoteId, draggedNodeId, focusNodeIds, hoveredNodeId, renderedNodes]);
  const graphStructureKey = useMemo(
    () =>
      JSON.stringify({
        nodeIds: documentsIndex.graphNodes.map((node) => node.id),
        edgeIds: documentsIndex.graphEdges.map((edge) => edge.id)
      }),
    [documentsIndex.graphEdges, documentsIndex.graphNodes]
  );

  useEffect(() => {
    nodeRadiusByIdRef.current = nodeRadiusById;
  }, [nodeRadiusById]);

  useEffect(() => {
    simulationNodesRef.current = simulationNodes;
  }, [simulationNodes]);

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
    setViewBox(createViewBoxForNodes(layoutNodes));
  }, [graphStructureKey, layoutNodes]);

  const getScreenToWorldTransform = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }

    const screenTransform = svg.getScreenCTM();
    if (!screenTransform) {
      return null;
    }

    return screenTransform.inverse();
  }, []);

  const clientToWorldPoint = useCallback(
    (clientX: number, clientY: number) => {
      const screenToWorldTransform = getScreenToWorldTransform();
      if (!screenToWorldTransform) {
        return null;
      }

      return transformClientPoint(clientX, clientY, screenToWorldTransform);
    },
    [getScreenToWorldTransform]
  );

  const saveSimulationPositions = useCallback(
    (nodes: DocumentGraphSimulationNode[]) => {
      if (nodes.length === 0) {
        return;
      }

      const nextPinnedPositions = createPinnedPositionsFromSimulationNodes(nodes);
      if (arePinnedPositionsEqual(pinnedPositionsRef.current, nextPinnedPositions)) {
        return;
      }

      pinnedPositionsRef.current = nextPinnedPositions;
      persistPinnedPositions(nextPinnedPositions);
      setPinnedPositions(nextPinnedPositions);
    },
    [persistPinnedPositions]
  );

  useEffect(() => {
    saveSimulationPositionsRef.current = saveSimulationPositions;
  }, [saveSimulationPositions]);

  const runSimulationFrame = useCallback(() => {
    animationFrameRef.current = null;

    const currentNodes = simulationNodesRef.current;
    if (currentNodes.length === 0) {
      return;
    }

    const interaction = nodeInteractionRef.current;
    const fixedNode =
      interaction?.isDragging === true
        ? {
            nodeId: interaction.nodeId,
            x: interaction.currentX,
            y: interaction.currentY
          }
        : null;
    const alpha = fixedNode ? Math.max(simulationAlphaRef.current, dragSimulationAlpha) : simulationAlphaRef.current;

    if (!fixedNode && alpha < simulationStopAlpha) {
      saveSimulationPositionsRef.current(currentNodes);
      return;
    }

    const nextNodes = stepDocumentGraphSimulation(currentNodes, graphEdgesRef.current, forceSettingsRef.current, {
      alpha,
      fixedNode,
      nodeRadiusById: nodeRadiusByIdRef.current
    });

    simulationNodesRef.current = nextNodes;
    setSimulationNodes(nextNodes);

    const nextAlpha = fixedNode ? dragSimulationAlpha : alpha * simulationAlphaDecay;
    simulationAlphaRef.current = nextAlpha;

    if (fixedNode || nextAlpha >= simulationStopAlpha) {
      scheduleSimulationRef.current();
      return;
    }

    saveSimulationPositionsRef.current(nextNodes);
  }, []);

  const scheduleSimulation = useCallback(() => {
    if (typeof window === "undefined" || animationFrameRef.current !== null) {
      return;
    }

    animationFrameRef.current = window.requestAnimationFrame(runSimulationFrame);
  }, [runSimulationFrame]);

  const reheatSimulation = useCallback(
    (alpha = 0.75) => {
      simulationAlphaRef.current = Math.max(simulationAlphaRef.current, alpha);
      scheduleSimulation();
    },
    [scheduleSimulation]
  );

  useEffect(() => {
    scheduleSimulationRef.current = scheduleSimulation;
  }, [scheduleSimulation]);

  useEffect(() => {
    const nextNodes = createDocumentGraphSimulationNodes(layoutNodes, simulationNodesRef.current);
    simulationNodesRef.current = nextNodes;
    setSimulationNodes(nextNodes);
    reheatSimulation(0.5);
  }, [graphStructureKey, layoutResetVersion, reheatSimulation]);

  useEffect(() => {
    reheatSimulation(0.8);
  }, [forceSettings, reheatSimulation]);

  useEffect(() => {
    reheatSimulation(0.5);
  }, [documentsIndex.graphEdges, reheatSimulation]);

  const clearNodeInteraction = useCallback(
    (persistLayout: boolean) => {
      const interaction = nodeInteractionRef.current;
      if (!interaction) {
        return;
      }

      if (persistLayout && interaction.isDragging) {
        saveSimulationPositionsRef.current(simulationNodesRef.current);
      }

      nodeInteractionRef.current = null;
      setDraggedNodeId(null);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }

      clearNodeInteraction(true);
    };
  }, [clearNodeInteraction]);

  const beginCanvasPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !svgRef.current) {
      return;
    }

    const screenToWorldTransform = getScreenToWorldTransform();
    if (!screenToWorldTransform) {
      return;
    }

    panStateRef.current = {
      pointerId: event.pointerId,
      originPoint: transformClientPoint(event.clientX, event.clientY, screenToWorldTransform),
      screenToWorldTransform,
      startViewBox: viewBoxRef.current
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateCanvasPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }

    const currentPoint = transformClientPoint(event.clientX, event.clientY, panState.screenToWorldTransform);
    const deltaX = currentPoint.x - panState.originPoint.x;
    const deltaY = currentPoint.y - panState.originPoint.y;

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
    const pointerWorldPoint = clientToWorldPoint(event.clientX, event.clientY);
    if (!pointerWorldPoint) {
      return;
    }

    const zoomFactor = event.deltaY > 0 ? 1.12 : 0.9;
    const nextWidth = Math.max(240, Math.min(3200, currentViewBox.width * zoomFactor));
    const nextHeight = Math.max(180, Math.min(2400, currentViewBox.height * zoomFactor));
    const pointerRatioX = (pointerWorldPoint.x - currentViewBox.x) / currentViewBox.width;
    const pointerRatioY = (pointerWorldPoint.y - currentViewBox.y) / currentViewBox.height;

    setViewBox({
      x: pointerWorldPoint.x - nextWidth * pointerRatioX,
      y: pointerWorldPoint.y - nextHeight * pointerRatioY,
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

    nodeInteractionRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      noteId: node.noteId,
      originX: event.clientX,
      originY: event.clientY,
      offsetX: pointerWorldPoint.x - node.x,
      offsetY: pointerWorldPoint.y - node.y,
      currentX: node.x,
      currentY: node.y,
      isDragging: false,
      hasMoved: false
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    setHoveredNodeId(node.id);
  };

  const updateNodeInteractionPosition = useCallback(
    (event: ReactPointerEvent<SVGGElement>) => {
      const interaction = nodeInteractionRef.current;
      if (!interaction) {
        return;
      }

      const pointerWorldPoint = clientToWorldPoint(event.clientX, event.clientY);
      if (!pointerWorldPoint) {
        return;
      }

      const nextX = pointerWorldPoint.x - interaction.offsetX;
      const nextY = pointerWorldPoint.y - interaction.offsetY;
      interaction.currentX = nextX;
      interaction.currentY = nextY;

      setSimulationNodes((current) => {
        const nextNodes = current.map((node) =>
          node.id === interaction.nodeId
            ? {
                ...node,
                x: nextX,
                y: nextY,
                vx: 0,
                vy: 0
              }
            : node
        );
        simulationNodesRef.current = nextNodes;
        return nextNodes;
      });

      setHoveredNodeId(interaction.nodeId);
      reheatSimulation(dragSimulationAlpha);
    },
    [clientToWorldPoint, reheatSimulation]
  );

  const applyForceSettingsImmediately = useCallback(
    (nextForceSettings: DocumentGraphForceSettings) => {
      const clampedForceSettings = clampDocumentGraphForceSettings(nextForceSettings);
      forceSettingsRef.current = clampedForceSettings;
      persistForceSettings(clampedForceSettings);
      setForceSettings(clampedForceSettings);

      setSimulationNodes((current) => {
        const sourceNodes = current.length > 0 ? current : simulationNodesRef.current;
        const interaction = nodeInteractionRef.current;
        const fixedNode =
          interaction?.isDragging === true
            ? {
                nodeId: interaction.nodeId,
                x: interaction.currentX,
                y: interaction.currentY
              }
            : null;
        let nextNodes = sourceNodes;

        for (let iteration = 0; iteration < 8; iteration += 1) {
          nextNodes = stepDocumentGraphSimulation(nextNodes, graphEdgesRef.current, clampedForceSettings, {
            alpha: 0.9,
            fixedNode,
            nodeRadiusById: nodeRadiusByIdRef.current
          });
        }

        simulationNodesRef.current = nextNodes;
        return nextNodes;
      });

      simulationAlphaRef.current = Math.max(simulationAlphaRef.current, 0.9);
      scheduleSimulationRef.current();
    },
    [persistForceSettings]
  );

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
      if (!interaction.hasMoved) {
        return;
      }

      interaction.isDragging = true;
      setDraggedNodeId(interaction.nodeId);
      reheatSimulation(dragSimulationAlpha);
    }

    updateNodeInteractionPosition(event);
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
    reheatSimulation(0.35);

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
    reheatSimulation(0.35);
  };

  const updateForceSetting = (key: DocumentGraphForceSettingKey, value: number) => {
    applyForceSettingsImmediately({
      ...forceSettingsRef.current,
      [key]: value
    });
  };

  const resetGraphForcesAndLayout = () => {
    const nextForceSettings = defaultDocumentGraphForceSettings;
    const resetLayoutNodes = computeDocumentGraphLayout(documentsIndex.graphNodes, documentsIndex.graphEdges, {
      pinnedPositions: {}
    });
    const nextSimulationNodes = createDocumentGraphSimulationNodes(resetLayoutNodes);

    forceSettingsRef.current = nextForceSettings;
    setForceSettings(nextForceSettings);
    persistForceSettings(nextForceSettings);
    pinnedPositionsRef.current = {};
    persistPinnedPositions({});
    setPinnedPositions({});
    simulationNodesRef.current = nextSimulationNodes;
    setSimulationNodes(nextSimulationNodes);
    setViewBox(createViewBoxForNodes(resetLayoutNodes));
    setLayoutResetVersion((current) => current + 1);
    reheatSimulation(1);
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
      {controlsPanelOpen ? (
        <div className="documents-graph-controls" aria-label="Graph controls">
          <div className="documents-graph-controls-row">
            <button
              type="button"
              className="documents-graph-controls-section"
              aria-expanded={false}
              title="Filters"
            >
              <span className="documents-graph-controls-section-icon">
                <ChevronRightIcon />
              </span>
              <span>Filters</span>
            </button>
            <div className="documents-graph-controls-actions">
              <button
                type="button"
                className="documents-graph-icon-button"
                onClick={resetGraphForcesAndLayout}
                aria-label="Reset graph forces and layout"
                title="Reset graph forces and layout"
              >
                <ResetIcon />
              </button>
              <button
                type="button"
                className="documents-graph-icon-button"
                onClick={() => setControlsPanelOpen(false)}
                aria-label="Hide graph controls"
                title="Hide graph controls"
              >
                <WindowCloseIcon />
              </button>
            </div>
          </div>

          <div className="documents-graph-controls-row">
            <button
              type="button"
              className="documents-graph-controls-section"
              aria-expanded={false}
              title="Groups"
            >
              <span className="documents-graph-controls-section-icon">
                <ChevronRightIcon />
              </span>
              <span>Groups</span>
            </button>
          </div>

          <div className="documents-graph-controls-row">
            <button
              type="button"
              className="documents-graph-controls-section"
              aria-expanded={false}
              title="Display"
            >
              <span className="documents-graph-controls-section-icon">
                <ChevronRightIcon />
              </span>
              <span>Display</span>
            </button>
          </div>

          <div className="documents-graph-controls-row">
            <button
              type="button"
              className="documents-graph-controls-section expanded"
              aria-expanded={true}
              title="Forces"
            >
              <span className="documents-graph-controls-section-icon">
                <ChevronDownIcon />
              </span>
              <span>Forces</span>
            </button>
          </div>

          <div className="documents-graph-forces">
            {forceControls.map((control) => (
              <label className="documents-graph-force-control" key={control.key}>
                <span>{control.label}</span>
                <input
                  type="range"
                  min={documentGraphForceSliderRange.min}
                  max={documentGraphForceSliderRange.max}
                  step={documentGraphForceSliderRange.step}
                  value={forceSettings[control.key]}
                  onInput={(event) => updateForceSetting(control.key, Number(event.currentTarget.value))}
                  onChange={(event) => updateForceSetting(control.key, Number(event.currentTarget.value))}
                  aria-label={control.label}
                />
              </label>
            ))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="documents-graph-controls-open"
          onClick={() => setControlsPanelOpen(true)}
          aria-label="Show graph controls"
          title="Show graph controls"
        >
          <GearIcon />
        </button>
      )}

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
          {renderedNodes.map((node) => {
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
