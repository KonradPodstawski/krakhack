import type {
  AdjacencyEntry,
  CentralityResult,
  Coordinate,
  GraphEdge,
  GraphNode,
  IsochroneResult,
  RouteMarker,
  RouteResult,
  RoutingGraph,
  SegmentFeatureCollection,
  H3CellSummary,
} from './smart-city'

// ---------------------------------------------------------------------------
// Constants (matching build script)
// ---------------------------------------------------------------------------

// Reduced from 5 (~1.1m) to 4 (~11m) to merge nearby segment endpoints
// that should logically connect but don't share exact GIS coordinates.
const GRAPH_SNAP_DECIMALS = 4

// Max gap (meters) to bridge between disconnected components with virtual edges.
// 100m gives ~80% of nodes in the largest component (up from 15% without bridging).
const AUTO_BRIDGE_MAX_DISTANCE_M = 100

// ---------------------------------------------------------------------------
// MinHeap (ported from build script)
// ---------------------------------------------------------------------------

interface HeapItem {
  node_id: number
  distance: number
}

class MinHeap {
  private items: HeapItem[] = []

  push(value: HeapItem) {
    this.items.push(value)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): HeapItem | null {
    if (this.items.length === 0) {
      return null
    }

    const first = this.items[0]
    const last = this.items.pop()!

    if (this.items.length > 0) {
      this.items[0] = last
      this.bubbleDown(0)
    }

    return first
  }

  isEmpty(): boolean {
    return this.items.length === 0
  }

  private bubbleUp(index: number) {
    let currentIndex = index

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2)

      if (this.items[parentIndex].distance <= this.items[currentIndex].distance) {
        return
      }

      ;[this.items[parentIndex], this.items[currentIndex]] = [
        this.items[currentIndex],
        this.items[parentIndex],
      ]
      currentIndex = parentIndex
    }
  }

  private bubbleDown(index: number) {
    let currentIndex = index

    while (true) {
      const leftIndex = currentIndex * 2 + 1
      const rightIndex = currentIndex * 2 + 2
      let smallestIndex = currentIndex

      if (
        leftIndex < this.items.length &&
        this.items[leftIndex].distance < this.items[smallestIndex].distance
      ) {
        smallestIndex = leftIndex
      }

      if (
        rightIndex < this.items.length &&
        this.items[rightIndex].distance < this.items[smallestIndex].distance
      ) {
        smallestIndex = rightIndex
      }

      if (smallestIndex === currentIndex) {
        return
      }

      ;[this.items[currentIndex], this.items[smallestIndex]] = [
        this.items[smallestIndex],
        this.items[currentIndex],
      ]
      currentIndex = smallestIndex
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinate utilities (ported from build script)
// ---------------------------------------------------------------------------

function coordinateKey(coordinate: Coordinate): string {
  return `${coordinate[0].toFixed(GRAPH_SNAP_DECIMALS)}:${coordinate[1].toFixed(GRAPH_SNAP_DECIMALS)}`
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function coordinateDistanceMeters(left: Coordinate, right: Coordinate): number {
  const referenceLatitude = (left[1] + right[1]) / 2
  const leftPoint = projectCoordinate(left, referenceLatitude)
  const rightPoint = projectCoordinate(right, referenceLatitude)
  const deltaX = leftPoint.x - rightPoint.x
  const deltaY = leftPoint.y - rightPoint.y

  return Math.sqrt(deltaX * deltaX + deltaY * deltaY)
}

function projectCoordinate(
  coordinate: Coordinate,
  referenceLatitude: number,
): { x: number; y: number } {
  const metersPerLatDegree = 111320
  const metersPerLonDegree = 111320 * Math.max(Math.cos((referenceLatitude * Math.PI) / 180), 0.2)

  return {
    x: coordinate[0] * metersPerLonDegree,
    y: coordinate[1] * metersPerLatDegree,
  }
}

// ---------------------------------------------------------------------------
// Edge cost
// ---------------------------------------------------------------------------

function computeEdgeTravelCost(lengthM: number, segmentScore: number): number {
  const normalizedScore = clamp(Number(segmentScore ?? 0), 0, 100)
  return lengthM * (1 + (100 - normalizedScore) / 100)
}

// ---------------------------------------------------------------------------
// Graph construction (ported from build script)
// ---------------------------------------------------------------------------

function getOrCreateGraphNode(
  nodeByKey: Map<string, GraphNode>,
  nodes: GraphNode[],
  coordinate: Coordinate,
): GraphNode {
  const key = coordinateKey(coordinate)
  const existing = nodeByKey.get(key)

  if (existing) {
    return existing
  }

  const node: GraphNode = {
    node_id: nodes.length + 1,
    coordinate: [round(coordinate[0], 6), round(coordinate[1], 6)],
  }

  nodeByKey.set(key, node)
  nodes.push(node)
  return node
}

function computeGraphComponents(
  nodes: GraphNode[],
  adjacency: AdjacencyEntry[][],
): {
  node_component_id_by_node_id: Record<number, number>
  largest_component_id: number
  component_count: number
} {
  const visited = new Set<number>()
  const nodeComponentIdByNodeId: Record<number, number> = {}
  let componentCount = 0
  let largestComponentNodes = 0
  let largestComponentId = 0

  for (const node of nodes) {
    if (visited.has(node.node_id)) {
      continue
    }

    componentCount += 1
    const queue = [node.node_id]
    visited.add(node.node_id)
    let nodeCount = 0

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!
      nodeCount += 1
      nodeComponentIdByNodeId[currentNodeId] = componentCount

      for (const neighbor of adjacency[currentNodeId]) {
        if (visited.has(neighbor.to_node_id)) {
          continue
        }

        visited.add(neighbor.to_node_id)
        queue.push(neighbor.to_node_id)
      }
    }

    if (nodeCount > largestComponentNodes || componentCount === 1) {
      largestComponentId = componentCount
      largestComponentNodes = nodeCount
    }
  }

  return {
    component_count: componentCount,
    largest_component_id: largestComponentId,
    node_component_id_by_node_id: nodeComponentIdByNodeId,
  }
}

export function buildRoutingGraph(
  segments: SegmentFeatureCollection,
  hexCells?: H3CellSummary[],
): RoutingGraph {
  const cellScoreByIndex = new Map<string, number>()
  if (hexCells) {
    for (const cell of hexCells) {
      cellScoreByIndex.set(cell.h3_index, cell.hex_score)
    }
  }

  // --- Phase 1: T-junction detection ---
  // Find segment endpoints that are near intermediate points of other segments.
  // Insert split-points so these T-intersections become graph junctions.

  const T_JUNCTION_MAX_M = 30

  // Spatial grid of all intermediate points for fast lookup
  const intermediateGrid = new Map<string, Array<{ coord: Coordinate; segIdx: number; ptIdx: number }>>()
  const igridSize = 0.0004 // ~44m

  for (let si = 0; si < segments.features.length; si++) {
    const coords = segments.features[si].geometry?.coordinates
    if (!coords || coords.length < 3) continue
    for (let pi = 1; pi < coords.length - 1; pi++) {
      const c = coords[pi] as Coordinate
      if (!isCoordinate(c)) continue
      const k = `${Math.floor(c[0] / igridSize)}:${Math.floor(c[1] / igridSize)}`
      let bucket = intermediateGrid.get(k)
      if (!bucket) { bucket = []; intermediateGrid.set(k, bucket) }
      bucket.push({ coord: c, segIdx: si, ptIdx: pi })
    }
  }

  // For each segment endpoint, find nearest intermediate point of a different segment
  // splitPoints: Map<segmentIndex, Set<coordIndex>> — points where to split that segment
  const splitPoints = new Map<number, Map<number, Coordinate>>()

  for (let si = 0; si < segments.features.length; si++) {
    const coords = segments.features[si].geometry?.coordinates
    if (!coords || coords.length < 2) continue
    const endpoints = [coords[0] as Coordinate, coords[coords.length - 1] as Coordinate]

    for (const ep of endpoints) {
      if (!isCoordinate(ep)) continue
      const cx = Math.floor(ep[0] / igridSize)
      const cy = Math.floor(ep[1] / igridSize)

      let bestDist = T_JUNCTION_MAX_M + 1
      let bestHit: { segIdx: number; ptIdx: number } | null = null

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = intermediateGrid.get(`${cx + dx}:${cy + dy}`)
          if (!bucket) continue
          for (const hit of bucket) {
            if (hit.segIdx === si) continue
            const d = coordinateDistanceMeters(ep, hit.coord)
            if (d < bestDist) {
              bestDist = d
              bestHit = hit
            }
          }
        }
      }

      if (bestHit) {
        let segSplits = splitPoints.get(bestHit.segIdx)
        if (!segSplits) { segSplits = new Map(); splitPoints.set(bestHit.segIdx, segSplits) }
        // Use the endpoint coordinate as the split point (so the node merges with endpoint via snap)
        segSplits.set(bestHit.ptIdx, ep)
      }
    }
  }

  let splitCount = 0
  for (const m of splitPoints.values()) splitCount += m.size

  // --- Phase 2: Build graph with split segments ---
  const nodeByKey = new Map<string, GraphNode>()
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  for (let si = 0; si < segments.features.length; si++) {
    const feature = segments.features[si]
    const coordinates = feature.geometry?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      continue
    }

    const segScore = round(Number(feature.properties.score ?? 0), 2)
    const segSplits = splitPoints.get(si)

    // Determine split indices for this segment (sorted)
    const splitIndices: number[] = []
    if (segSplits) {
      for (const ptIdx of segSplits.keys()) {
        splitIndices.push(ptIdx)
      }
      splitIndices.sort((a, b) => a - b)
    }

    // Generate sub-segments: [0..split1], [split1..split2], ..., [splitN..end]
    const breakpoints = [0, ...splitIndices, coordinates.length - 1]
    const uniqueBreakpoints = breakpoints.filter((v, i, a) => i === 0 || v !== a[i - 1])

    for (let bi = 0; bi < uniqueBreakpoints.length - 1; bi++) {
      const fromIdx = uniqueBreakpoints[bi]
      const toIdx = uniqueBreakpoints[bi + 1]
      if (toIdx - fromIdx < 1) continue

      const subCoords = coordinates.slice(fromIdx, toIdx + 1) as Coordinate[]
      const startCoord = segSplits?.get(fromIdx) ?? subCoords[0]
      const endCoord = segSplits?.get(toIdx) ?? subCoords[subCoords.length - 1]

      if (!isCoordinate(startCoord) || !isCoordinate(endCoord)) continue

      const startNode = getOrCreateGraphNode(nodeByKey, nodes, startCoord)
      const endNode = getOrCreateGraphNode(nodeByKey, nodes, endCoord)

      // Compute sub-segment length
      let subLengthM = 0
      for (let ci = 0; ci < subCoords.length - 1; ci++) {
        subLengthM += coordinateDistanceMeters(subCoords[ci], subCoords[ci + 1])
      }
      subLengthM = Math.max(1, subLengthM)

      edges.push({
        edge_id: edges.length + 1,
        segment_id: feature.properties.segment_id,
        start_node_id: startNode.node_id,
        end_node_id: endNode.node_id,
        coordinates: subCoords,
        length_m: round(subLengthM, 2),
        segment_score: segScore,
        edge_h3_index: null,
        edge_h3_score: segScore,
        edge_cost: round(computeEdgeTravelCost(subLengthM, segScore), 4),
      })
    }
  }

  // --- Phase 3: Build adjacency ---
  const adjacency: AdjacencyEntry[][] = Array.from({ length: nodes.length + 1 }, () => [])

  edges.forEach((edge, edgeIndex) => {
    if (edge.start_node_id === edge.end_node_id) {
      return
    }

    adjacency[edge.start_node_id].push({
      to_node_id: edge.end_node_id,
      edge_index: edgeIndex,
      cost: edge.edge_cost,
    })
    adjacency[edge.end_node_id].push({
      to_node_id: edge.start_node_id,
      edge_index: edgeIndex,
      cost: edge.edge_cost,
    })
  })

  // --- Phase 4: Auto-bridge disconnected components ---
  const initialComponents = computeGraphComponents(nodes, adjacency)
  const componentById = initialComponents.node_component_id_by_node_id

  const gridCellSize = 0.001 // ~110m in lat/lng
  const spatialGrid = new Map<string, number[]>()

  for (const node of nodes) {
    const cellKey = `${Math.floor(node.coordinate[0] / gridCellSize)}:${Math.floor(node.coordinate[1] / gridCellSize)}`
    let bucket = spatialGrid.get(cellKey)
    if (!bucket) {
      bucket = []
      spatialGrid.set(cellKey, bucket)
    }
    bucket.push(node.node_id)
  }

  let bridgeCount = 0

  for (const node of nodes) {
    const cx = Math.floor(node.coordinate[0] / gridCellSize)
    const cy = Math.floor(node.coordinate[1] / gridCellSize)
    const nodeComp = componentById[node.node_id]

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = spatialGrid.get(`${cx + dx}:${cy + dy}`)
        if (!bucket) continue

        for (const otherNodeId of bucket) {
          if (otherNodeId <= node.node_id) continue
          if (componentById[otherNodeId] === nodeComp) continue

          const otherNode = nodes[otherNodeId - 1]
          const dist = coordinateDistanceMeters(node.coordinate, otherNode.coordinate)
          if (dist > AUTO_BRIDGE_MAX_DISTANCE_M || dist < 0.5) continue

          const bridgeEdge: GraphEdge = {
            edge_id: edges.length + 1,
            segment_id: -1,
            start_node_id: node.node_id,
            end_node_id: otherNodeId,
            coordinates: [node.coordinate, otherNode.coordinate],
            length_m: round(dist, 2),
            segment_score: 50,
            edge_h3_index: null,
            edge_h3_score: 50,
            edge_cost: round(computeEdgeTravelCost(dist, 50), 4),
          }

          const edgeIndex = edges.length
          edges.push(bridgeEdge)

          adjacency[node.node_id].push({
            to_node_id: otherNodeId,
            edge_index: edgeIndex,
            cost: bridgeEdge.edge_cost,
          })
          adjacency[otherNodeId].push({
            to_node_id: node.node_id,
            edge_index: edgeIndex,
            cost: bridgeEdge.edge_cost,
          })

          const otherComp = componentById[otherNodeId]
          for (const n of nodes) {
            if (componentById[n.node_id] === otherComp) {
              componentById[n.node_id] = nodeComp
            }
          }

          bridgeCount++
        }
      }
    }
  }

  const finalComponents = computeGraphComponents(nodes, adjacency)

  // --- Phase 5: Assign H3 cell index to each edge ---
  const h3 = await_h3()
  let h3AssignedCount = 0
  if (h3 && hexCells && hexCells.length > 0) {
    const H3_RESOLUTION = hexCells[0].h3_resolution ?? 8
    const validIndices = new Set<string>()
    for (const cell of hexCells) validIndices.add(cell.h3_index)

    for (const edge of edges) {
      // Use midpoint of edge coordinates
      const midIdx = Math.floor(edge.coordinates.length / 2)
      const midCoord = edge.coordinates[midIdx]
      try {
        const cellIndex = h3.latLngToCell(midCoord[1], midCoord[0], H3_RESOLUTION)
        if (validIndices.has(cellIndex)) {
          edge.edge_h3_index = cellIndex
          edge.edge_h3_score = cellScoreByIndex.get(cellIndex) ?? edge.segment_score
          h3AssignedCount++
        }
      } catch {
        // Edge outside valid H3 range — keep null
      }
    }
  }

  console.log(
    `[routing] Graph: ${nodes.length} nodes, ${edges.length} edges, ` +
    `${splitCount} T-junctions, ${bridgeCount} bridges, ` +
    `${finalComponents.component_count} components (was ${initialComponents.component_count}), ` +
    `${h3AssignedCount}/${edges.length} edges with H3 cell`
  )

  return {
    nodes,
    edges,
    adjacency,
    largest_component_id: finalComponents.largest_component_id,
    node_component_id_by_node_id: finalComponents.node_component_id_by_node_id,
  }
}

// h3-js is a heavy module; try to load it lazily
let _h3Module: typeof import('h3-js') | null | false = null

function await_h3(): typeof import('h3-js') | null {
  // Return cached result
  if (_h3Module === false) return null
  if (_h3Module) return _h3Module
  return null
}

export async function preloadH3(): Promise<void> {
  if (_h3Module !== null) return
  try {
    _h3Module = await import('h3-js')
  } catch {
    _h3Module = false
  }
}

// ---------------------------------------------------------------------------
// Nearest node search
// ---------------------------------------------------------------------------

export function findNearestNode(
  coordinate: Coordinate,
  graph: RoutingGraph,
  maxDistanceMeters = 800,
): RouteMarker | null {
  let best: RouteMarker | null = null

  for (const node of graph.nodes) {
    const distance = coordinateDistanceMeters(coordinate, node.coordinate)

    if (distance > maxDistanceMeters) {
      continue
    }

    if (!best || distance < best.snap_distance_m) {
      best = {
        coordinate: node.coordinate,
        node_id: node.node_id,
        snap_distance_m: round(distance, 1),
      }
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Dijkstra shortest path (ported from build script)
// ---------------------------------------------------------------------------

export function dijkstra(
  graph: RoutingGraph,
  startNodeId: number,
  targetNodeId: number,
  edgeCosts?: number[] | null,
): RouteResult | null {
  if (!startNodeId || !targetNodeId || startNodeId === targetNodeId) {
    return null
  }

  const nodeCount = graph.nodes.length + 1
  const distances = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY)
  const previousNode = new Int32Array(nodeCount).fill(-1)
  const previousEdgeIndex = new Int32Array(nodeCount).fill(-1)
  const heap = new MinHeap()

  distances[startNodeId] = 0
  heap.push({ node_id: startNodeId, distance: 0 })

  while (!heap.isEmpty()) {
    const current = heap.pop()!
    if (current.distance > distances[current.node_id]) {
      continue
    }

    if (current.node_id === targetNodeId) {
      break
    }

    for (const neighbor of graph.adjacency[current.node_id]) {
      const neighborCost = edgeCosts?.[neighbor.edge_index] ?? neighbor.cost
      const nextDistance = current.distance + neighborCost

      if (nextDistance >= distances[neighbor.to_node_id]) {
        continue
      }

      distances[neighbor.to_node_id] = nextDistance
      previousNode[neighbor.to_node_id] = current.node_id
      previousEdgeIndex[neighbor.to_node_id] = neighbor.edge_index
      heap.push({
        node_id: neighbor.to_node_id,
        distance: nextDistance,
      })
    }
  }

  if (!Number.isFinite(distances[targetNodeId])) {
    return null
  }

  const steps: RouteResult['steps'] = []
  let cursor = targetNodeId

  while (cursor !== startNodeId) {
    const edgeIndex = previousEdgeIndex[cursor]
    const fromNodeId = previousNode[cursor]

    if (edgeIndex < 0 || fromNodeId < 0) {
      return null
    }

    steps.push({
      from_node_id: fromNodeId,
      to_node_id: cursor,
      edge_index: edgeIndex,
    })
    cursor = fromNodeId
  }

  steps.reverse()

  return buildRouteResult(graph, steps, distances[targetNodeId])
}

// ---------------------------------------------------------------------------
// A* shortest path (new - heuristic: haversine distance)
// ---------------------------------------------------------------------------

export function astar(
  graph: RoutingGraph,
  startNodeId: number,
  targetNodeId: number,
  edgeCosts?: number[] | null,
): RouteResult | null {
  if (!startNodeId || !targetNodeId || startNodeId === targetNodeId) {
    return null
  }

  const targetNode = graph.nodes[targetNodeId - 1]
  if (!targetNode) {
    return null
  }

  const nodeCount = graph.nodes.length + 1
  const gScore = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY)
  const previousNode = new Int32Array(nodeCount).fill(-1)
  const previousEdgeIndex = new Int32Array(nodeCount).fill(-1)
  const closed = new Uint8Array(nodeCount)
  const heap = new MinHeap()

  gScore[startNodeId] = 0
  const startHeuristic = heuristic(graph.nodes[startNodeId - 1], targetNode)
  heap.push({ node_id: startNodeId, distance: startHeuristic })

  while (!heap.isEmpty()) {
    const current = heap.pop()!

    if (current.node_id === targetNodeId) {
      break
    }

    if (closed[current.node_id]) {
      continue
    }
    closed[current.node_id] = 1

    for (const neighbor of graph.adjacency[current.node_id]) {
      if (closed[neighbor.to_node_id]) {
        continue
      }

      const neighborCost = edgeCosts?.[neighbor.edge_index] ?? neighbor.cost
      const tentativeG = gScore[current.node_id] + neighborCost

      if (tentativeG >= gScore[neighbor.to_node_id]) {
        continue
      }

      gScore[neighbor.to_node_id] = tentativeG
      previousNode[neighbor.to_node_id] = current.node_id
      previousEdgeIndex[neighbor.to_node_id] = neighbor.edge_index

      const h = heuristic(graph.nodes[neighbor.to_node_id - 1], targetNode)
      heap.push({
        node_id: neighbor.to_node_id,
        distance: tentativeG + h,
      })
    }
  }

  if (!Number.isFinite(gScore[targetNodeId])) {
    return null
  }

  const steps: RouteResult['steps'] = []
  let cursor = targetNodeId

  while (cursor !== startNodeId) {
    const edgeIndex = previousEdgeIndex[cursor]
    const fromNodeId = previousNode[cursor]

    if (edgeIndex < 0 || fromNodeId < 0) {
      return null
    }

    steps.push({
      from_node_id: fromNodeId,
      to_node_id: cursor,
      edge_index: edgeIndex,
    })
    cursor = fromNodeId
  }

  steps.reverse()

  return buildRouteResult(graph, steps, gScore[targetNodeId])
}

function heuristic(from: GraphNode, to: GraphNode): number {
  // Admissible heuristic: straight-line distance in meters
  // This is a lower bound on actual cost because edge_cost >= length_m
  return coordinateDistanceMeters(from.coordinate, to.coordinate)
}

// ---------------------------------------------------------------------------
// Vibe-weighted edge costs
// ---------------------------------------------------------------------------

export type VibeMetricKey =
  | 'air_proxy'
  | 'demand'
  | 'greenery'
  | 'infrastructure_access'
  | 'infrastructure_density'
  | 'network'
  | 'quality'
  | 'quietness'
  | 'rack_access'
  | 'rack_density'

export interface VibeWeights {
  weights: Record<VibeMetricKey, number>
}

export function buildVibeEdgeCosts(
  graph: RoutingGraph,
  hexCells: H3CellSummary[],
  activeVibes: VibeWeights[],
  alpha: number,
): number[] {
  if (activeVibes.length === 0 || alpha <= 0) {
    // Pure shortest path - cost = length only
    return graph.edges.map((edge) => edge.length_m)
  }

  const cellByIndex = new Map<string, H3CellSummary>()
  for (const cell of hexCells) {
    cellByIndex.set(cell.h3_index, cell)
  }

  // Cost formula: length_m × (1 + alpha × penalty(vibeScore))
  //
  // penalty uses exponential curve so low-vibe segments are strongly avoided:
  //   penalty(vibe) = ((100 - vibe) / 100) ^ 1.5
  //
  // Examples at different alpha values:
  //   alpha=0 → pure distance (no vibe influence)
  //   alpha=1, vibe=50 → cost = length × 1.35  (mild preference)
  //   alpha=1, vibe=0  → cost = length × 2.0   (double cost)
  //   alpha=3, vibe=50 → cost = length × 2.06  (noticeable detours)
  //   alpha=3, vibe=0  → cost = length × 4.0   (strong avoidance)
  //   alpha=9, vibe=50 → cost = length × 4.18  (heavy vibe-first)
  //   alpha=9, vibe=0  → cost = length × 10.0  (extreme avoidance)

  return graph.edges.map((edge) => {
    const cell = edge.edge_h3_index ? cellByIndex.get(edge.edge_h3_index) : null
    const vibeScore = cell ? computeVibeScore(cell, activeVibes) : 50 // no cell = neutral

    const deficit = (100 - vibeScore) / 100 // 0 (perfect vibe) to 1 (worst vibe)
    const penalty = deficit ** 1.5 // exponential: makes bad vibes disproportionately costly
    const vibeMultiplier = 1 + alpha * penalty
    return edge.length_m * vibeMultiplier
  })
}

function computeVibeScore(cell: H3CellSummary, vibes: VibeWeights[]): number {
  const metrics = buildCellMetrics(cell)
  let totalScore = 0
  let totalWeight = 0

  for (const vibe of vibes) {
    let vibeWeightedSum = 0
    let vibeAbsWeight = 0

    for (const key of METRIC_KEYS) {
      const w = vibe.weights[key]
      if (Math.abs(w) === 0) continue

      const raw = metrics[key]
      const affinity = w >= 0 ? raw : 100 - raw
      vibeWeightedSum += affinity * Math.abs(w)
      vibeAbsWeight += Math.abs(w)
    }

    if (vibeAbsWeight > 0) {
      totalScore += vibeWeightedSum / vibeAbsWeight
      totalWeight += 1
    }
  }

  return totalWeight > 0 ? totalScore / totalWeight : 50
}

const METRIC_KEYS: VibeMetricKey[] = [
  'air_proxy',
  'demand',
  'greenery',
  'infrastructure_access',
  'infrastructure_density',
  'network',
  'quality',
  'quietness',
  'rack_access',
  'rack_density',
]

function buildCellMetrics(cell: H3CellSummary): Record<VibeMetricKey, number> {
  return {
    air_proxy: cell.air_proxy_score ?? clamp(cell.mean_greenery_score * 0.55 + (100 - cell.mean_noise_score) * 0.45, 0, 100),
    demand: cell.demand_score,
    greenery: cell.mean_greenery_score,
    infrastructure_access: cell.mean_infrastructure_score,
    infrastructure_density: cell.infrastructure_density_score ?? 0,
    network: cell.network_score,
    quality: cell.quality_score,
    quietness: 100 - cell.mean_noise_score,
    rack_access: cell.mean_rack_score,
    rack_density: cell.rack_density_score ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Route result builder
// ---------------------------------------------------------------------------

function buildRouteResult(
  graph: RoutingGraph,
  steps: RouteResult['steps'],
  totalCost: number,
): RouteResult {
  const coordinates: Coordinate[] = []
  const segmentIds: number[] = []
  let totalLengthM = 0
  let scoreSum = 0

  for (const step of steps) {
    const edge = graph.edges[step.edge_index]
    segmentIds.push(edge.segment_id)
    totalLengthM += edge.length_m
    scoreSum += edge.segment_score

    // Determine direction: if step.from_node_id matches edge.start_node_id, use as-is
    const edgeCoords =
      step.from_node_id === edge.start_node_id
        ? edge.coordinates
        : [...edge.coordinates].reverse()

    // Skip first coordinate of subsequent edges to avoid duplication at junctions
    const startIdx = coordinates.length > 0 ? 1 : 0
    for (let i = startIdx; i < edgeCoords.length; i++) {
      coordinates.push(edgeCoords[i])
    }
  }

  return {
    total_cost: round(totalCost, 2),
    total_length_m: round(totalLengthM, 1),
    segment_count: segmentIds.length,
    mean_score: steps.length > 0 ? round(scoreSum / steps.length, 1) : 0,
    coordinates,
    segment_ids: segmentIds,
    steps,
  }
}

// ---------------------------------------------------------------------------
// Isochrones — reachability polygons from a start point
// ---------------------------------------------------------------------------

export function computeIsochrone(
  graph: RoutingGraph,
  startNodeId: number,
  bands: Array<{ cost_limit: number; label: string }>,
): IsochroneResult | null {
  if (!startNodeId || bands.length === 0) return null

  const startNode = graph.nodes[startNodeId - 1]
  if (!startNode) return null

  const maxCost = Math.max(...bands.map((b) => b.cost_limit))

  // Run Dijkstra from start (no target — explore entire reachable set)
  const nodeCount = graph.nodes.length + 1
  const distances = new Float64Array(nodeCount).fill(Number.POSITIVE_INFINITY)
  const heap = new MinHeap()

  distances[startNodeId] = 0
  heap.push({ node_id: startNodeId, distance: 0 })

  while (!heap.isEmpty()) {
    const current = heap.pop()!
    if (current.distance > distances[current.node_id]) continue
    if (current.distance > maxCost) continue

    for (const neighbor of graph.adjacency[current.node_id]) {
      // Use length_m as cost for isochrones (physical distance)
      const edgeLengthM = graph.edges[neighbor.edge_index].length_m
      const nextDistance = current.distance + edgeLengthM

      if (nextDistance >= distances[neighbor.to_node_id] || nextDistance > maxCost) continue

      distances[neighbor.to_node_id] = nextDistance
      heap.push({ node_id: neighbor.to_node_id, distance: nextDistance })
    }
  }

  // Build convex hull for each band
  const result: IsochroneResult = {
    origin: startNode.coordinate,
    bands: [],
  }

  for (const band of bands.sort((a, b) => b.cost_limit - a.cost_limit)) {
    const reachableCoords: Coordinate[] = []

    for (let i = 0; i < graph.nodes.length; i++) {
      if (distances[i + 1] <= band.cost_limit) {
        reachableCoords.push(graph.nodes[i].coordinate)
      }
    }

    if (reachableCoords.length < 3) continue

    result.bands.push({
      cost_limit: band.cost_limit,
      label: band.label,
      coordinates: convexHull(reachableCoords),
    })
  }

  return result
}

function convexHull(points: Coordinate[]): Coordinate[] {
  if (points.length < 3) return points

  // Andrew's monotone chain algorithm
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const cross = (o: Coordinate, a: Coordinate, b: Coordinate) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  // Lower hull
  const lower: Coordinate[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  // Upper hull
  const upper: Coordinate[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  // Remove last point of each half because it's repeated
  lower.pop()
  upper.pop()

  const hull = [...lower, ...upper]
  // Close the polygon
  if (hull.length > 0) hull.push(hull[0])

  return hull
}

// ---------------------------------------------------------------------------
// Network Centrality — Betweenness & Closeness
// ---------------------------------------------------------------------------

export function computeCentrality(
  graph: RoutingGraph,
  sampleSize = 200,
): CentralityResult {
  const nodeCount = graph.nodes.length
  const edgeCount = graph.edges.length
  const betweenness = new Float64Array(edgeCount)
  const closenessSum = new Float64Array(nodeCount + 1)
  const closenessReachable = new Uint32Array(nodeCount + 1)

  // Sample nodes for approximate centrality (exact is O(V*E), too slow for >3000 nodes)
  const sampleNodes: number[] = []
  const step = Math.max(1, Math.floor(nodeCount / sampleSize))
  for (let i = 0; i < nodeCount; i += step) {
    sampleNodes.push(graph.nodes[i].node_id)
  }

  // Brandes algorithm (modified for edge betweenness) on sampled sources
  for (const source of sampleNodes) {
    // BFS/Dijkstra from source
    const dist = new Float64Array(nodeCount + 1).fill(Number.POSITIVE_INFINITY)
    const sigma = new Float64Array(nodeCount + 1) // number of shortest paths
    const pred: number[][] = Array.from({ length: nodeCount + 1 }, () => [])
    const predEdge: number[][] = Array.from({ length: nodeCount + 1 }, () => [])
    const stack: number[] = []
    const heap = new MinHeap()

    dist[source] = 0
    sigma[source] = 1
    heap.push({ node_id: source, distance: 0 })

    while (!heap.isEmpty()) {
      const current = heap.pop()!
      if (current.distance > dist[current.node_id]) continue
      stack.push(current.node_id)

      for (const neighbor of graph.adjacency[current.node_id]) {
        const edgeCost = graph.edges[neighbor.edge_index].length_m
        const newDist = dist[current.node_id] + edgeCost

        // New shorter path found
        if (newDist < dist[neighbor.to_node_id] - 0.01) {
          dist[neighbor.to_node_id] = newDist
          sigma[neighbor.to_node_id] = sigma[current.node_id]
          pred[neighbor.to_node_id] = [current.node_id]
          predEdge[neighbor.to_node_id] = [neighbor.edge_index]
          heap.push({ node_id: neighbor.to_node_id, distance: newDist })
        } else if (Math.abs(newDist - dist[neighbor.to_node_id]) < 0.01) {
          // Equal-cost path
          sigma[neighbor.to_node_id] += sigma[current.node_id]
          pred[neighbor.to_node_id].push(current.node_id)
          predEdge[neighbor.to_node_id].push(neighbor.edge_index)
        }
      }
    }

    // Accumulate closeness for this source
    for (let i = 1; i <= nodeCount; i++) {
      if (Number.isFinite(dist[i]) && dist[i] > 0) {
        closenessSum[source] += dist[i]
        closenessReachable[source]++
      }
    }

    // Back-propagation for edge betweenness
    const delta = new Float64Array(nodeCount + 1)

    while (stack.length > 0) {
      const w = stack.pop()!
      for (let pi = 0; pi < pred[w].length; pi++) {
        const v = pred[w][pi]
        const ei = predEdge[w][pi]
        const contribution = (sigma[v] / sigma[w]) * (1 + delta[w])
        betweenness[ei] += contribution
        delta[v] += contribution
      }
    }
  }

  // Normalize betweenness by sample size
  const scaleFactor = nodeCount / sampleNodes.length
  let maxBetweenness = 0
  for (let i = 0; i < edgeCount; i++) {
    betweenness[i] *= scaleFactor
    if (betweenness[i] > maxBetweenness) maxBetweenness = betweenness[i]
  }

  // Compute closeness centrality: C(v) = reachable / sum_of_distances
  const closeness = new Float64Array(nodeCount + 1)
  let maxCloseness = 0
  for (const nodeId of sampleNodes) {
    if (closenessSum[nodeId] > 0 && closenessReachable[nodeId] > 1) {
      closeness[nodeId] = closenessReachable[nodeId] / closenessSum[nodeId]
      if (closeness[nodeId] > maxCloseness) maxCloseness = closeness[nodeId]
    }
  }

  return {
    betweenness_by_edge: betweenness,
    closeness_by_node: closeness,
    max_betweenness: maxBetweenness,
    max_closeness: maxCloseness,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}
