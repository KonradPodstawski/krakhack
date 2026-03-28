import type { StyleSpecification } from 'maplibre-gl'

export type Bounds = [number, number, number, number]
export type Coordinate = [number, number]
export const KRAKOW_CENTER: Coordinate = [19.94498, 50.06143]

export interface SegmentProperties {
  center: Coordinate | null
  comfort_score: number
  corridor_usage_count?: number
  greenery_ratio: number
  greenery_points: number
  greenery_score: number
  infrastructure_points: number
  infrastructure_score: number
  is_top_segment: boolean
  kind: string | null
  length_km: number
  max_noise_db: number | null
  nearest_infra_m: number | null
  nearest_rack_m: number | null
  noise_points: number
  noise_score: number
  rack_points: number
  rack_score: number
  score: number
  score_rank: number | null
  segment_id: number
  surface: string | null
}

export interface TopSegment {
  center: Coordinate | null
  comfort_score: number
  greenery_ratio: number
  greenery_points: number
  greenery_score: number
  infrastructure_points: number
  infrastructure_score: number
  kind: string | null
  length_km: number
  max_noise_db: number | null
  nearest_infra_m: number | null
  nearest_rack_m: number | null
  noise_points: number
  noise_score: number
  rack_points: number
  rack_score: number
  score: number
  score_rank: number | null
  segment_id: number
  surface: string | null
}

export interface DataSourceMeta {
  file: string
  geometry: string
  id: string
  label: string
  normalized_crs: string
  source_crs: string
  usage: string[]
}

export interface ProcessingStepMeta {
  description: string
  id: string
  step: number
  title: string
}

export interface MapLayerMeta {
  data_source: string
  id: string
  order: number
  role: string
}

export interface ScoringWeights {
  greenery: number
  infrastructure: number
  noise: number
  rack: number
}

export interface ScoreReferenceRange {
  best: number
  missingScore: number
  worst: number
}

export interface ScoringReferences {
  infrastructureDistanceM: ScoreReferenceRange
  noiseDb: ScoreReferenceRange
  rackDistanceM: ScoreReferenceRange
}

export interface ScoringMeta {
  formula: string
  output_range: [number, number]
  references: ScoringReferences
  sample_step_meters: number
  tie_breakers: string[]
  version: string
  weights: ScoringWeights
}

export interface CorridorScenarioMeta {
  edge_cost_formula: string
  edge_score_formula: string
  h3_resolution: number
  hub_count: number
  hub_source: string
  id: string
  kind?: string | null
  label: string
  max_hub_snap_distance_meters: number
  min_hub_separation_meters: number
  min_pair_distance_meters: number
  metric_key?: string | null
  metric_label?: string | null
  pair_priority_formula: string
  recommended_corridor_count: number
}

export interface H3ScenarioMeta {
  cell_score_formula: string
  demand_score_formula: string
  edge_score_formula: string
  hub_count: number
  id: string
  label: string
  max_hub_snap_distance_meters: number
  min_hub_separation_meters: number
  network_score_formula: string
  quality_score_formula: string
  resolution: number
  top_cell_count: number
}

export interface ConnectorScenarioMeta {
  crossing_method: string
  id: string
  label: string
  max_connector_length_meters: number
  min_connector_length_meters: number
  priority_formula: string
  recommended_connector_count: number
  source_component: string
  target_component_limit: number
}

export interface ExplainabilityMeta {
  connector_optimization: {
    connector_definition: string
    data_used: string[]
    endpoint_proximity_tolerance_meters: number
    planning_note: string
    qualification_steps: string[]
    scenario: ConnectorScenarioMeta
    why_this_is_not_guessing: string
  }
  corridor_optimization: {
    graph_snap_decimals: number
    scenario: CorridorScenarioMeta
  }
  h3_indexing: {
    scenario: H3ScenarioMeta
  }
  data_sources: DataSourceMeta[]
  limitations: string[]
  map_layers: MapLayerMeta[]
  nondeterminism: string[]
  processing_steps: ProcessingStepMeta[]
  scoring: ScoringMeta
}

export interface NearestNeighborIndexMeta {
  expected_mean_distance_m: number
  nni: number
  observed_mean_distance_m: number
  pattern: string
}

export interface StandardDeviationalEllipseMeta {
  center: Coordinate | null
  major_axis_sd_m: number
  minor_axis_sd_m: number
  rotation_deg: number
}

export interface SpatialPointSetSummary {
  count: number
  mean_center: Coordinate | null
  nearest_neighbor_index: NearestNeighborIndexMeta | null
  standard_deviational_ellipse: StandardDeviationalEllipseMeta | null
}

export interface SpatialStatisticsSummary {
  bike_infrastructure: SpatialPointSetSummary
  bike_racks: SpatialPointSetSummary
  demand_points: SpatialPointSetSummary
  hotspot_centers: SpatialPointSetSummary
  segment_centers: SpatialPointSetSummary
}

export interface NetworkAnalysisSummary {
  average_degree: number
  component_summaries: ComponentSummary[]
  connected_components: number
  edges: number
  largest_component_edges: number
  largest_component_nodes: number
  max_corridor_usage_count: number
  nodes: number
  self_loop_edges: number
  total_network_length_km: number
}

export interface ComponentSummary {
  bounds: Bounds | null
  center: Coordinate | null
  component_id: number
  demand_point_count: number
  demand_weight: number
  edge_count: number
  infrastructure_count: number
  label: string
  node_count: number
  rack_count: number
  total_edge_length_km: number
}

export interface HotspotSummary {
  air_proxy_score?: number
  center: Coordinate
  cell_id: string
  component_id?: number | null
  density_score: number
  graph_node_id: number
  h3_index: string
  h3_resolution: number
  hex_score: number
  hub_id: number
  infrastructure_count: number
  infrastructure_density_score?: number
  label: string
  mean_segment_score: number
  network_score: number
  point_count: number
  quality_score: number
  rack_count: number
  rack_density_score?: number
  route_metric_key?: string | null
  route_metric_label?: string | null
  route_score?: number
  scenario_id?: string | null
  scenario_label?: string | null
  snap_distance_m: number
  demand_score: number
  total_weight: number
}

export interface RecommendedCorridor {
  bounds: Bounds | null
  center: Coordinate | null
  corridor_id: number
  corridor_key?: string
  corridor_rank: number
  direct_distance_km: number
  from_h3_index: string
  from_hub_id: number
  from_label: string
  label: string
  max_noise_db: number | null
  mean_greenery_ratio: number
  mean_h3_score: number
  mean_infrastructure_distance_m: number | null
  mean_rack_distance_m: number | null
  mean_segment_score: number
  min_h3_score: number
  min_segment_score: number
  pair_priority: number
  path_cost: number
  path_length_km: number
  route_metric_key?: string | null
  route_metric_label?: string | null
  scenario_id?: string | null
  scenario_label?: string | null
  segment_count: number
  to_h3_index: string
  to_hub_id: number
  to_label: string
}

export interface CorridorRecommendationScenario {
  hotspots: HotspotSummary[]
  recommended: RecommendedCorridor[]
  scenario: CorridorScenarioMeta
}

export interface CorridorRecommendationsSummary {
  hotspots: HotspotSummary[]
  recommended: RecommendedCorridor[]
  scenario: CorridorScenarioMeta
  scenarios: CorridorRecommendationScenario[]
}

export interface RecommendedConnector {
  bounds: Bounds | null
  center: Coordinate | null
  connector_id: number
  connector_rank: number
  crossing_penalty_points: number
  demand_gain_points: number
  distance_points: number
  environment_points: number
  greenery_ratio: number
  label: string
  length_km: number
  length_m: number
  max_noise_db: number | null
  network_crossings_count: number
  network_gain_points: number
  noise_score: number
  priority_score: number
  source_component_demand_weight: number
  source_component_id: number
  source_component_label: string
  source_node_id: number
  target_component_demand_weight: number
  target_component_edges: number
  target_component_id: number
  target_component_label: string
  target_component_nodes: number
  target_node_id: number
}

export interface OffNetworkConnectorsSummary {
  recommended: RecommendedConnector[]
  scenario: ConnectorScenarioMeta
}

export interface H3CellSummary {
  air_proxy_score?: number
  bounds: Bounds | null
  center: Coordinate
  covered_segment_count: number
  demand_score: number
  demand_weight: number
  h3_index: string
  h3_resolution: number
  hex_score: number
  infrastructure_count: number
  max_noise_db: number | null
  mean_greenery_ratio: number
  mean_greenery_score: number
  mean_infrastructure_score: number
  mean_nearest_infra_m: number | null
  mean_nearest_rack_m: number | null
  mean_noise_score: number
  mean_rack_score: number
  mean_segment_score: number
  network_score: number
  point_count: number
  quality_score: number
  rack_count: number
  rack_density_score?: number
  segment_sample_count: number
  infrastructure_density_score?: number
  total_segment_length_km: number
}

export interface H3GridSummary {
  active_cells: number
  hubs: HotspotSummary[]
  scenario: H3ScenarioMeta
  top_cells: H3CellSummary[]
}

export interface HexFeatureCollection {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: {
      type: 'Polygon'
      coordinates: Coordinate[][]
    }
    properties: H3CellSummary & {
      display_color?: string
      display_outline_color?: string
      display_opacity?: number
      dominant_vibe?: string | null
    }
  }>
}

export interface SegmentFeatureCollection {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: {
      type: 'LineString'
      coordinates: Coordinate[]
    }
    properties: SegmentProperties
  }>
}

export interface PointProperties {
  count: number | null
  description: string | null
  name: string | null
  point_id: number
  point_kind: 'rack' | 'infrastructure'
  status: string | null
  type: string | null
}

export interface PointFeatureCollection {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: {
      type: 'Point'
      coordinates: Coordinate
    }
    properties: PointProperties
  }>
}

export interface Summary {
  bounds: Bounds | null
  counts: {
    bike_infrastructure_points: number
    bike_racks: number
    cycling_path_segments: number
    greenery_polygons: number
    noise_polygons: number
  }
  corridor_recommendations: CorridorRecommendationsSummary
  explainability: ExplainabilityMeta
  h3_grid: H3GridSummary
  network_analysis: NetworkAnalysisSummary
  off_network_connectors: OffNetworkConnectorsSummary
  score: {
    max: number
    mean: number
    median: number
    min: number
  }
  spatial_statistics: SpatialStatisticsSummary
  top_score_threshold: number
  top_segments: TopSegment[]
}

export const MAP_STYLE: StyleSpecification = {
  version: 8,
  name: 'Krakow OSM Gray',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-saturation': -1,
        'raster-contrast': 0.08,
        'raster-brightness-min': 0.22,
        'raster-brightness-max': 0.82,
        'raster-opacity': 0.84,
      },
    },
  ],
}

export function formatDistance(value: number | null) {
  if (value == null) {
    return 'brak'
  }

  return `${Math.round(value)} m`
}

export function formatKilometers(value: number | null) {
  if (value == null) {
    return 'brak'
  }

  return `${value.toFixed(2)} km`
}

export function formatNoise(value: number | null) {
  if (value == null) {
    return 'brak'
  }

  return `${value.toFixed(1)} dB`
}

export function formatPercent(value: number | null) {
  if (value == null) {
    return 'brak'
  }

  return `${(value * 100).toFixed(1)}%`
}

export function formatScore(value: number) {
  return value.toFixed(1)
}

export function formatPoints(value: number) {
  return `${value.toFixed(1)} pkt`
}

export function formatCount(value: number | null) {
  if (value == null) {
    return 'brak'
  }

  return `${Math.round(value)}`
}

export function scoreColor(score: number) {
  if (score >= 80) {
    return '#166534'
  }
  if (score >= 65) {
    return '#65a30d'
  }
  if (score >= 50) {
    return '#d97706'
  }
  return '#b91c1c'
}

// ---------------------------------------------------------------------------
// Routing types
// ---------------------------------------------------------------------------

export interface GraphNode {
  node_id: number
  coordinate: Coordinate
}

export interface GraphEdge {
  edge_id: number
  segment_id: number
  start_node_id: number
  end_node_id: number
  coordinates: Coordinate[]
  length_m: number
  segment_score: number
  edge_h3_index: string | null
  edge_h3_score: number
  edge_cost: number
}

export interface AdjacencyEntry {
  to_node_id: number
  edge_index: number
  cost: number
}

export interface RoutingGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  adjacency: AdjacencyEntry[][]
  largest_component_id: number
  node_component_id_by_node_id: Record<number, number>
}

export interface RouteResult {
  total_cost: number
  total_length_m: number
  segment_count: number
  mean_score: number
  coordinates: Coordinate[]
  segment_ids: number[]
  steps: Array<{ from_node_id: number; to_node_id: number; edge_index: number }>
}

export interface RouteMarker {
  coordinate: Coordinate
  node_id: number
  snap_distance_m: number
}
