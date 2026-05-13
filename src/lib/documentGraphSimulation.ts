import type {
  DocumentGraphEdge,
  DocumentGraphLayoutNode,
  DocumentGraphPinnedPositions,
  DocumentGraphPoint
} from "../models/documents";

export interface DocumentGraphForceSettings {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export interface DocumentGraphForceParameters {
  centerStrength: number;
  repulsionStrength: number;
  linkStrength: number;
  linkDistance: number;
  danglingLinkDistance: number;
  collisionSpacing: number;
  damping: number;
  velocityLimit: number;
}

export interface DocumentGraphSimulationNode extends DocumentGraphLayoutNode {
  vx: number;
  vy: number;
}

export interface DocumentGraphFixedNode {
  nodeId: string;
  x: number;
  y: number;
}

export const documentGraphForceSliderRange = {
  min: 0,
  max: 100,
  step: 1
} as const;

export const defaultDocumentGraphForceSettings: DocumentGraphForceSettings = {
  centerForce: 50,
  repelForce: 50,
  linkForce: 50,
  linkDistance: 50
};

const baseCenterStrength = 0.002;
const baseRepulsionStrength = 34_000;
const baseLinkStrength = 0.013;
const baseLinkDistance = 150;
const minLinkDistance = 80;
const maxLinkDistance = 220;
const defaultCollisionSpacing = 10;
const defaultDamping = 0.84;
const defaultVelocityLimit = 80;

function clampSliderValue(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(documentGraphForceSliderRange.min, Math.min(documentGraphForceSliderRange.max, value));
}

function getFallbackDirection(firstNodeId: string, secondNodeId: string) {
  let hash = 0;
  const value = `${firstNodeId}:${secondNodeId}`;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }

  const angle = ((Math.abs(hash) % 360) / 360) * Math.PI * 2;
  return {
    x: Math.cos(angle),
    y: Math.sin(angle)
  };
}

function clampVelocity(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

function getNodeRadius(nodeRadiusById: Map<string, number> | undefined, nodeId: string) {
  return nodeRadiusById?.get(nodeId) ?? 20;
}

export function clampDocumentGraphForceSettings(
  settings: Partial<DocumentGraphForceSettings> | null | undefined
): DocumentGraphForceSettings {
  return {
    centerForce: clampSliderValue(settings?.centerForce, defaultDocumentGraphForceSettings.centerForce),
    repelForce: clampSliderValue(settings?.repelForce, defaultDocumentGraphForceSettings.repelForce),
    linkForce: clampSliderValue(settings?.linkForce, defaultDocumentGraphForceSettings.linkForce),
    linkDistance: clampSliderValue(settings?.linkDistance, defaultDocumentGraphForceSettings.linkDistance)
  };
}

export function documentGraphForceSettingsToParameters(
  settings: DocumentGraphForceSettings
): DocumentGraphForceParameters {
  const clampedSettings = clampDocumentGraphForceSettings(settings);
  const distanceRatio =
    clampedSettings.linkDistance /
    Math.max(1, documentGraphForceSliderRange.max - documentGraphForceSliderRange.min);
  const linkDistance = minLinkDistance + (maxLinkDistance - minLinkDistance) * distanceRatio;

  return {
    centerStrength: baseCenterStrength * (clampedSettings.centerForce / defaultDocumentGraphForceSettings.centerForce),
    repulsionStrength:
      baseRepulsionStrength * (clampedSettings.repelForce / defaultDocumentGraphForceSettings.repelForce),
    linkStrength: baseLinkStrength * (clampedSettings.linkForce / defaultDocumentGraphForceSettings.linkForce),
    linkDistance,
    danglingLinkDistance: linkDistance + 50,
    collisionSpacing: defaultCollisionSpacing,
    damping: defaultDamping,
    velocityLimit: defaultVelocityLimit
  };
}

export function createDocumentGraphSimulationNodes(
  layoutNodes: DocumentGraphLayoutNode[],
  previousNodes: DocumentGraphSimulationNode[] = []
): DocumentGraphSimulationNode[] {
  const previousNodeById = new Map(previousNodes.map((node) => [node.id, node]));

  return layoutNodes.map((node) => {
    const previousNode = previousNodeById.get(node.id);
    if (previousNode) {
      return {
        ...node,
        x: previousNode.x,
        y: previousNode.y,
        vx: previousNode.vx,
        vy: previousNode.vy
      };
    }

    return {
      ...node,
      vx: 0,
      vy: 0
    };
  });
}

export function createPinnedPositionsFromSimulationNodes(
  nodes: DocumentGraphSimulationNode[]
): DocumentGraphPinnedPositions {
  return Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
}

export function stepDocumentGraphSimulation(
  nodes: DocumentGraphSimulationNode[],
  edges: DocumentGraphEdge[],
  settings: DocumentGraphForceSettings,
  options?: {
    alpha?: number;
    fixedNode?: DocumentGraphFixedNode | null;
    nodeRadiusById?: Map<string, number>;
  }
): DocumentGraphSimulationNode[] {
  if (nodes.length === 0) {
    return [];
  }

  const parameters = documentGraphForceSettingsToParameters(settings);
  const alpha = Math.max(0, Math.min(1, options?.alpha ?? 0.25));
  const fixedNode = options?.fixedNode ?? null;
  const fixedNodeId = fixedNode?.nodeId ?? null;
  const nextNodes = nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nextNodes.map((node) => [node.id, node]));
  const forcesById = new Map<string, DocumentGraphPoint>();

  nextNodes.forEach((node) => {
    forcesById.set(node.id, { x: 0, y: 0 });
  });

  if (fixedNode) {
    const node = nodeById.get(fixedNode.nodeId);
    if (node) {
      node.x = fixedNode.x;
      node.y = fixedNode.y;
      node.vx = 0;
      node.vy = 0;
    }
  }

  for (let firstIndex = 0; firstIndex < nextNodes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < nextNodes.length; secondIndex += 1) {
      const firstNode = nextNodes[firstIndex];
      const secondNode = nextNodes[secondIndex];
      let dx = secondNode.x - firstNode.x;
      let dy = secondNode.y - firstNode.y;
      let distance = Math.hypot(dx, dy);

      if (distance < 0.001) {
        const fallbackDirection = getFallbackDirection(firstNode.id, secondNode.id);
        dx = fallbackDirection.x;
        dy = fallbackDirection.y;
        distance = 1;
      }

      const clampedDistance = Math.max(12, distance);
      const directionX = dx / distance;
      const directionY = dy / distance;
      const repulsion = parameters.repulsionStrength / (clampedDistance * clampedDistance);
      const firstForce = forcesById.get(firstNode.id);
      const secondForce = forcesById.get(secondNode.id);

      if (firstForce) {
        firstForce.x -= directionX * repulsion;
        firstForce.y -= directionY * repulsion;
      }

      if (secondForce) {
        secondForce.x += directionX * repulsion;
        secondForce.y += directionY * repulsion;
      }
    }
  }

  edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) {
      return;
    }

    let dx = targetNode.x - sourceNode.x;
    let dy = targetNode.y - sourceNode.y;
    let distance = Math.hypot(dx, dy);
    if (distance < 0.001) {
      const fallbackDirection = getFallbackDirection(edge.source, edge.target);
      dx = fallbackDirection.x;
      dy = fallbackDirection.y;
      distance = 1;
    }

    const desiredDistance = edge.isDangling ? parameters.danglingLinkDistance : parameters.linkDistance;
    const spring = (distance - desiredDistance) * parameters.linkStrength * Math.max(1, edge.count);
    const forceX = (dx / distance) * spring;
    const forceY = (dy / distance) * spring;
    const sourceForce = forcesById.get(edge.source);
    const targetForce = forcesById.get(edge.target);

    if (sourceForce) {
      sourceForce.x += forceX;
      sourceForce.y += forceY;
    }

    if (targetForce) {
      targetForce.x -= forceX;
      targetForce.y -= forceY;
    }
  });

  nextNodes.forEach((node) => {
    if (node.id === fixedNodeId) {
      return;
    }

    const force = forcesById.get(node.id);
    if (!force) {
      return;
    }

    force.x += -node.x * parameters.centerStrength;
    force.y += -node.y * parameters.centerStrength;

    node.vx = clampVelocity((node.vx + force.x * alpha) * parameters.damping, parameters.velocityLimit);
    node.vy = clampVelocity((node.vy + force.y * alpha) * parameters.damping, parameters.velocityLimit);
    node.x += node.vx;
    node.y += node.vy;
  });

  for (let pass = 0; pass < 2; pass += 1) {
    for (let firstIndex = 0; firstIndex < nextNodes.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < nextNodes.length; secondIndex += 1) {
        const firstNode = nextNodes[firstIndex];
        const secondNode = nextNodes[secondIndex];
        const minimumDistance =
          getNodeRadius(options?.nodeRadiusById, firstNode.id) +
          getNodeRadius(options?.nodeRadiusById, secondNode.id) +
          parameters.collisionSpacing;
        let dx = secondNode.x - firstNode.x;
        let dy = secondNode.y - firstNode.y;
        let distance = Math.hypot(dx, dy);

        if (distance >= minimumDistance) {
          continue;
        }

        if (distance < 0.001) {
          const fallbackDirection = getFallbackDirection(firstNode.id, secondNode.id);
          dx = fallbackDirection.x;
          dy = fallbackDirection.y;
          distance = 1;
        }

        const directionX = dx / distance;
        const directionY = dy / distance;
        const overlap = minimumDistance - distance;

        if (firstNode.id === fixedNodeId) {
          secondNode.x += directionX * overlap;
          secondNode.y += directionY * overlap;
          secondNode.vx += directionX * overlap * 0.08;
          secondNode.vy += directionY * overlap * 0.08;
          continue;
        }

        if (secondNode.id === fixedNodeId) {
          firstNode.x -= directionX * overlap;
          firstNode.y -= directionY * overlap;
          firstNode.vx -= directionX * overlap * 0.08;
          firstNode.vy -= directionY * overlap * 0.08;
          continue;
        }

        const adjustment = overlap / 2;
        firstNode.x -= directionX * adjustment;
        firstNode.y -= directionY * adjustment;
        secondNode.x += directionX * adjustment;
        secondNode.y += directionY * adjustment;
      }
    }
  }

  if (fixedNode) {
    const node = nodeById.get(fixedNode.nodeId);
    if (node) {
      node.x = fixedNode.x;
      node.y = fixedNode.y;
      node.vx = 0;
      node.vy = 0;
    }
  }

  return nextNodes;
}

export const documentGraphBaseForceConstants = {
  centerStrength: baseCenterStrength,
  repulsionStrength: baseRepulsionStrength,
  linkStrength: baseLinkStrength,
  linkDistance: baseLinkDistance
} as const;
