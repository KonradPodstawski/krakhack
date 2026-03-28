import type { StyleSpecification } from 'maplibre-gl'

export type Bounds = [number, number, number, number]
export type Coordinate = [number, number]
export const KRAKOW_CENTER: Coordinate = [19.94498, 50.06143]

export interface SegmentProperties {
  center: Coordinate | null
  comfort_score: number
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

export interface ExplainabilityMeta {
  data_sources: DataSourceMeta[]
  limitations: string[]
  map_layers: MapLayerMeta[]
  nondeterminism: string[]
  processing_steps: ProcessingStepMeta[]
  scoring: ScoringMeta
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
  explainability: ExplainabilityMeta
  score: {
    max: number
    mean: number
    median: number
    min: number
  }
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
