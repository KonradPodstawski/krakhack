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
  hotspot_bandwidth_meters: number
  hotspot_count: number
  hotspot_grid_meters: number
  id: string
  label: string
  max_hub_snap_distance_meters: number
  min_hotspot_separation_meters: number
  min_pair_distance_meters: number
  pair_priority_formula: string
  recommended_corridor_count: number
}

export interface ExplainabilityMeta {
  corridor_optimization: {
    graph_snap_decimals: number
    scenario: CorridorScenarioMeta
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
  connected_components: number
  edges: number
  largest_component_edges: number
  largest_component_nodes: number
  max_corridor_usage_count: number
  nodes: number
  self_loop_edges: number
  total_network_length_km: number
}

export interface HotspotSummary {
  center: Coordinate
  cell_id: string
  density_score: number
  graph_node_id: number
  hub_id: number
  infrastructure_count: number
  label: string
  point_count: number
  rack_count: number
  snap_distance_m: number
  total_weight: number
}

export interface RecommendedCorridor {
  bounds: Bounds | null
  center: Coordinate | null
  corridor_id: number
  corridor_rank: number
  direct_distance_km: number
  from_hub_id: number
  from_label: string
  label: string
  max_noise_db: number | null
  mean_greenery_ratio: number
  mean_infrastructure_distance_m: number | null
  mean_rack_distance_m: number | null
  mean_segment_score: number
  min_segment_score: number
  pair_priority: number
  path_cost: number
  path_length_km: number
  segment_count: number
  to_hub_id: number
  to_label: string
}

export interface CorridorRecommendationsSummary {
  hotspots: HotspotSummary[]
  recommended: RecommendedCorridor[]
  scenario: CorridorScenarioMeta
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
  network_analysis: NetworkAnalysisSummary
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
