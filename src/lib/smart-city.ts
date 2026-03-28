import type { StyleSpecification } from 'maplibre-gl'

export type Bounds = [number, number, number, number]
export type Coordinate = [number, number]
export const KRAKOW_CENTER: Coordinate = [19.94498, 50.06143]

export interface SegmentProperties {
  center: Coordinate | null
  comfort_score: number
  greenery_ratio: number
  is_top_segment: boolean
  kind: string | null
  length_km: number
  max_noise_db: number | null
  nearest_infra_m: number | null
  nearest_rack_m: number | null
  score: number
  score_rank: number | null
  segment_id: number
  surface: string | null
}

export interface TopSegment {
  center: Coordinate | null
  comfort_score: number
  greenery_ratio: number
  kind: string | null
  length_km: number
  max_noise_db: number | null
  nearest_infra_m: number | null
  nearest_rack_m: number | null
  score: number
  score_rank: number | null
  segment_id: number
  surface: string | null
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
  name: 'Krakow OSM',
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
