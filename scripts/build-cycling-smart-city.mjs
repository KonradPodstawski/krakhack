import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import shp from 'shpjs'
import proj4 from 'proj4'
import * as turf from '@turf/turf'
import RBush from 'rbush'
import * as h3 from 'h3-js'

const DEFAULT_ZIP_PATH = path.resolve(
  'Smart Infrastructure Challenge',
  'cycling-smart-city',
  'data.zip',
)
const DEFAULT_OUTPUT_DIR = path.resolve('public', 'generated', 'cycling-smart-city')

const SOURCE_ZIP_PATH = path.resolve(process.argv[2] ?? DEFAULT_ZIP_PATH)
const OUTPUT_DIR = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT_DIR)

const SAMPLE_STEP_METERS = 180
const TOP_SEGMENT_COUNT = 20
const GRAPH_SNAP_DECIMALS = 5
const H3_RESOLUTION = 8
const H3_HUB_COUNT = 6
const H3_MIN_HUB_DISTANCE_METERS = 1400
const H3_MAX_NODE_DISTANCE_METERS = 700
const H3_TOP_CELL_COUNT = 20
const MIN_CORRIDOR_DISTANCE_METERS = 2000
const RECOMMENDED_CORRIDOR_COUNT = 5
const MIN_CONNECTOR_LENGTH_METERS = 80
const MAX_CONNECTOR_LENGTH_METERS = 1800
const RECOMMENDED_CONNECTOR_COUNT = 6
const CONNECTOR_TARGET_COMPONENT_LIMIT = 20
const CONNECTOR_ENDPOINT_PROXIMITY_TOLERANCE_METERS = 20
const DEMAND_POINT_WEIGHTS = Object.freeze({
  rack: 1,
  infrastructure: 2.5,
})
const SCORE_WEIGHTS = Object.freeze({
  greenery: 0.35,
  noise: 0.3,
  rack: 0.2,
  infrastructure: 0.15,
})
const SCORE_REFERENCES = Object.freeze({
  noiseDb: { best: 45, worst: 85, missingScore: 50 },
  rackDistanceM: { best: 0, worst: 500, missingScore: 0 },
  infrastructureDistanceM: { best: 0, worst: 800, missingScore: 0 },
})
const H3_SCORE_WEIGHTS = Object.freeze({
  demand: 0.45,
  network: 0.2,
  quality: 0.35,
})
const H3_SCENARIO = Object.freeze({
  id: 'h3_corridor_index_v1',
  label: 'Uber-style H3 corridor indexing',
  resolution: H3_RESOLUTION,
  hub_count: H3_HUB_COUNT,
  top_cell_count: H3_TOP_CELL_COUNT,
  min_hub_separation_meters: H3_MIN_HUB_DISTANCE_METERS,
  max_hub_snap_distance_meters: H3_MAX_NODE_DISTANCE_METERS,
  demand_score_formula: 'demand_score = normalize(weighted demand in cell)',
  network_score_formula: 'network_score = normalize(segment sample count in cell)',
  quality_score_formula: 'quality_score = mean(segment score sampled in cell)',
  cell_score_formula:
    'hex_score = demand_score*0.45 + network_score*0.20 + quality_score*0.35',
  edge_score_formula: 'edge_h3_score = hex_score(cell_at_segment_midpoint)',
})
const CORRIDOR_SCENARIO = Object.freeze({
  id: 'h3_balanced_corridor_v2',
  label: 'H3 balanced corridor priority',
  hub_source: 'top_h3_cells',
  h3_resolution: H3_RESOLUTION,
  hub_count: H3_HUB_COUNT,
  min_hub_separation_meters: H3_MIN_HUB_DISTANCE_METERS,
  max_hub_snap_distance_meters: H3_MAX_NODE_DISTANCE_METERS,
  min_pair_distance_meters: MIN_CORRIDOR_DISTANCE_METERS,
  recommended_corridor_count: RECOMMENDED_CORRIDOR_COUNT,
  edge_cost_formula: 'edge_cost = length_m * (1 + (100 - edge_h3_score) / 100)',
  edge_score_formula: 'edge_h3_score = hex_score(cell_at_segment_midpoint)',
  pair_priority_formula:
    'pair_priority = (from_hex_score + to_hex_score) * direct_distance_km',
})
const CONNECTOR_SCENARIO = Object.freeze({
  id: 'off_network_connector_v1',
  label: 'Fragmentation repair connectors',
  source_component: 'largest_component',
  min_connector_length_meters: MIN_CONNECTOR_LENGTH_METERS,
  max_connector_length_meters: MAX_CONNECTOR_LENGTH_METERS,
  recommended_connector_count: RECOMMENDED_CONNECTOR_COUNT,
  target_component_limit: CONNECTOR_TARGET_COMPONENT_LIMIT,
  priority_formula:
    'priority = demand_gain_points + network_gain_points + distance_points + environment_points - crossing_penalty_points',
  crossing_method:
    'count intersections with existing segments, excluding intersections within 20 m of connector endpoints',
})
const DATA_SOURCES = Object.freeze([
  {
    id: 'bike_racks',
    label: 'Stojaki ZTP',
    file: 'data/Stojaki_ZTP.geojson',
    geometry: 'Point/MultiPoint',
    source_crs: 'EPSG:4326',
    normalized_crs: 'EPSG:4326',
    usage: ['nearest_rack_m', 'map layer: points-racks'],
  },
  {
    id: 'bike_infrastructure',
    label: 'Infrastruktura rowerowa ZTP',
    file: 'data/Infrastruktura_rowerowa_ZTP.geojson',
    geometry: 'Point/MultiPoint',
    source_crs: 'EPSG:4326',
    normalized_crs: 'EPSG:4326',
    usage: ['nearest_infra_m', 'map layer: points-infrastructure'],
  },
  {
    id: 'cycling_paths',
    label: 'Ciagi rowerowe',
    file: 'data/Ciagi_rowerowe/ciagi_rowerowe.shp',
    geometry: 'LineString/MultiLineString',
    source_crs: 'ETRF2000-PL CS2000 zone 7',
    normalized_crs: 'EPSG:4326',
    usage: ['segment geometry', 'base ranking unit', 'map layer: segments-base'],
  },
  {
    id: 'greenery',
    label: 'Zielen BDOT10k',
    file: 'data/Zielen/{PTLZ,PTTR,PTUT}/*.shp',
    geometry: 'Polygon/MultiPolygon',
    source_crs: 'CS92',
    normalized_crs: 'EPSG:4326',
    usage: ['greenery_ratio', 'not rendered directly'],
  },
  {
    id: 'noise',
    label: 'Warstwy halasu',
    file: 'data/halas/*/*.geojson',
    geometry: 'Polygon/MultiPolygon',
    source_crs: 'ETRF2000-PL CS2000 zone 7',
    normalized_crs: 'EPSG:4326',
    usage: ['max_noise_db', 'not rendered directly'],
  },
])
const PROCESSING_STEPS = Object.freeze([
  {
    step: 1,
    id: 'load_zip',
    title: 'Wczytanie paczki',
    description: 'Pliki sa czytane z data.zip po jawnych sciezkach i posortowanych wpisach ZIP.',
  },
  {
    step: 2,
    id: 'normalize_crs',
    title: 'Normalizacja CRS',
    description: 'Wszystkie warstwy sa sprowadzane do EPSG:4326 przed analiza i renderowaniem.',
  },
  {
    step: 3,
    id: 'flatten_geometry',
    title: 'Ujednolicenie geometrii',
    description: 'Multi-geometrie sa splaszczane, a wspolrzedne sa normalizowane do prostych tablic liczb.',
  },
  {
    step: 4,
    id: 'derive_metrics',
    title: 'Wyliczenie metryk segmentu',
    description:
      'Dla kazdego segmentu liczone sa dlugosc, odleglosc do stojaka, odleglosc do infrastruktury, pokrycie zieleni i maksymalny halas.',
  },
  {
    step: 5,
    id: 'score_segments',
    title: 'Wyjasnialny scoring',
    description:
      'Kazda metryka jest zamieniana na subscore 0-100, a finalny wynik to wazona suma liniowa bez ukrytych progow czasowych.',
  },
  {
    step: 6,
    id: 'rank_segments',
    title: 'Ranking',
    description:
      'Ranking sortuje po score malejaco, potem po dluzszym segmencie, a na koncu po segment_id rosnaco.',
  },
  {
    step: 7,
    id: 'h3_indexing',
    title: 'Indeksowanie H3',
    description:
      'Popyt i jakosc segmentow sa agregowane do stalej siatki H3, a kazdy aktywny heks dostaje jawny score 0-100.',
  },
  {
    step: 8,
    id: 'corridor_routing',
    title: 'Trasowanie po grafie',
    description:
      'Huby H3 sa mapowane do wezlow grafu, a rekomendowane korytarze sa liczone algorytmem Dijkstra po koszcie zaleznym od score heksa H3.',
  },
  {
    step: 9,
    id: 'off_network_connectors',
    title: 'Laczniki miedzy komponentami',
    description:
      'Dla rozlacznych komponentow sieci generowane sa kandydaty nowych lacznikow do najwiekszego komponentu, z jawna punktacja priorytetu.',
  },
])
const MAP_LAYER_ORDER = Object.freeze([
  {
    order: 1,
    id: 'osm',
    role: 'basemap',
    data_source: 'OpenStreetMap raster',
  },
  {
    order: 2,
    id: 'hexes-fill',
    role: 'h3 score grid',
    data_source: 'hexes.geojson',
  },
  {
    order: 3,
    id: 'segments-base',
    role: 'all scored segments',
    data_source: 'segments.geojson',
  },
  {
    order: 4,
    id: 'corridors-base',
    role: 'recommended corridor outline',
    data_source: 'corridors.geojson',
  },
  {
    order: 5,
    id: 'corridors-fill',
    role: 'recommended corridor highlight',
    data_source: 'corridors.geojson',
  },
  {
    order: 6,
    id: 'corridors-selected',
    role: 'selected corridor highlight',
    data_source: 'corridors.geojson',
  },
  {
    order: 7,
    id: 'connectors-base',
    role: 'off-network connector outline',
    data_source: 'connectors.geojson',
  },
  {
    order: 8,
    id: 'connectors-fill',
    role: 'off-network connector proposal',
    data_source: 'connectors.geojson',
  },
  {
    order: 9,
    id: 'connectors-selected',
    role: 'selected off-network connector',
    data_source: 'connectors.geojson',
  },
  {
    order: 10,
    id: 'segments-top-casing',
    role: 'top segment outline',
    data_source: 'segments.geojson',
  },
  {
    order: 11,
    id: 'segments-top-fill',
    role: 'top segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 12,
    id: 'segments-selected',
    role: 'selected segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 13,
    id: 'hotspots',
    role: 'h3 route hubs',
    data_source: 'hotspots.geojson',
  },
  {
    order: 14,
    id: 'points-racks',
    role: 'bike racks',
    data_source: 'points.geojson',
  },
  {
    order: 15,
    id: 'points-infrastructure',
    role: 'bike infrastructure points',
    data_source: 'points.geojson',
  },
])
const METHOD_LIMITATIONS = Object.freeze([
  'Zielen i halas sa oceniane przez probkowanie linii co staly krok, a nie przez pelne przeciecie bufora powierzchniowego.',
  'Podklad OSM sluzy tylko do orientacji przestrzennej i nie wchodzi do score.',
  'Brak warstwy ruchu drogowego, nachylenia i bezpieczenstwa skrzyzowan, wiec ranking nie jest pelna ocena jakosci trasy.',
  'Rekomendowane korytarze poruszaja sie po istniejacej geometrii sieci rowerowej; nie projektuja nowych linii przez tereny bez danych sieciowych.',
  'Score H3 korzysta z punktow popytu i probkowania segmentow; nie ma tu danych demograficznych, przejazdow ani ruchu rzeczywistego.',
  'Proponowane laczniki off-network nie sprawdzaja kolizji z budynkami, woda ani dzialkami, bo takich warstw nie ma w paczce challenge.',
])
const NONDETERMINISM = Object.freeze([
  'Jedyny runtime zewnetrzny na froncie to raster OSM; wynik analityczny i ranking sa lokalne i statyczne.',
])

const NOISE_SOURCE_BY_FOLDER = {
  '0': 'road_ldwn',
  '1': 'road_ln',
  '2': 'rail_ldwn',
  '3': 'rail_ln',
  '4': 'industry_ldwn',
  '5': 'industry_ln',
  '6': 'tram_ldwn',
  '7': 'tram_ln',
}

proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs')
proj4.defs(
  'PL_CS2000_ZONE_7',
  '+proj=tmerc +lat_0=0 +lon_0=21 +k=0.999923 +x_0=7500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
)
proj4.defs(
  'PL_CS92',
  '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs',
)

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  await ensureFileExists(SOURCE_ZIP_PATH)

  const zip = new AdmZip(SOURCE_ZIP_PATH)
  const datasets = await loadDatasets(zip)
  console.log(
    `Loaded datasets: ${datasets.cyclingPaths.features.length} segments, ` +
      `${datasets.bikeRacks.features.length} racks, ` +
      `${datasets.bikeInfrastructure.features.length} infrastructure points, ` +
      `${datasets.greenery.features.length} greenery polygons, ` +
      `${datasets.noise.features.length} noise polygons.`,
  )
  const scoredSegments = scoreCyclingSegments(datasets)
  const h3Analysis = buildH3Analysis(datasets, scoredSegments)
  const graph = buildCyclingGraph(scoredSegments, h3Analysis.cell_score_by_index)
  const componentSummaries = buildComponentSummaries(graph, datasets)
  const demandHotspots = buildH3RouteHubs(h3Analysis.cells, graph)
  const corridorAnalysis = buildCorridorRecommendations(scoredSegments, graph, demandHotspots)
  const connectorAnalysis = buildOffNetworkConnectors(
    datasets,
    scoredSegments,
    graph,
    componentSummaries,
  )
  applyCorridorUsage(scoredSegments, corridorAnalysis.segmentUsageBySegmentId)
  const pointsLayer = buildPointsLayer(datasets)
  const hexesLayer = buildHexesLayer(h3Analysis.cells)
  const hotspotsLayer = buildHotspotsLayer(corridorAnalysis.hotspots)
  const corridorsLayer = buildCorridorsLayer(corridorAnalysis.corridors)
  const connectorsLayer = buildConnectorsLayer(connectorAnalysis.connectors)
  const spatialStatistics = buildSpatialStatistics(
    datasets,
    scoredSegments,
    demandHotspots,
    safeBbox(scoredSegments),
  )
  const summary = buildSummary(
    datasets,
    scoredSegments,
    graph,
    spatialStatistics,
    h3Analysis,
    corridorAnalysis,
    connectorAnalysis,
    componentSummaries,
  )

  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  await Promise.all([
    writeJson(path.join(OUTPUT_DIR, 'segments.geojson'), scoredSegments),
    writeJson(path.join(OUTPUT_DIR, 'points.geojson'), pointsLayer),
    writeJson(path.join(OUTPUT_DIR, 'hexes.geojson'), hexesLayer),
    writeJson(path.join(OUTPUT_DIR, 'hotspots.geojson'), hotspotsLayer),
    writeJson(path.join(OUTPUT_DIR, 'corridors.geojson'), corridorsLayer),
    writeJson(path.join(OUTPUT_DIR, 'connectors.geojson'), connectorsLayer),
    writeJson(path.join(OUTPUT_DIR, 'summary.json'), summary),
  ])

  console.log(
    JSON.stringify(
      {
        output_dir: OUTPUT_DIR,
        zip_path: SOURCE_ZIP_PATH,
        counts: summary.counts,
        score: summary.score,
        top_score_threshold: summary.top_score_threshold,
      },
      null,
      2,
    ),
  )
}

async function loadDatasets(zip) {
  const bikeRacksRaw = readZipGeoJson(zip, 'data/Stojaki_ZTP.geojson')
  const bikeInfrastructureRaw = readZipGeoJson(zip, 'data/Infrastruktura_rowerowa_ZTP.geojson')
  const cyclingPathsRaw = await loadShapefileFromZip(
    zip,
    'data/Ciagi_rowerowe/ciagi_rowerowe',
  )

  const greeneryRaw = mergeFeatureCollections(
    await Promise.all(
      [
        {
          stem: 'data/Zielen/PTLZ/PL.PZGiK.283.1261__OT_PTLZ_A',
          category: 'PTLZ',
        },
        {
          stem: 'data/Zielen/PTTR/PL.PZGiK.283.1261__OT_PTTR_A',
          category: 'PTTR',
        },
        {
          stem: 'data/Zielen/PTUT/PL.PZGiK.283.1261__OT_PTUT_A',
          category: 'PTUT',
        },
      ].map(async ({ stem, category }) =>
        tagFeatures(await loadShapefileFromZip(zip, stem), {
          greenery_category: category,
        }),
      ),
    ),
  )

  const noiseEntries = zip
    .getEntries()
    .filter(
      (entry) =>
        !entry.isDirectory &&
        entry.entryName.startsWith('data/halas/') &&
        entry.entryName.endsWith('.geojson') &&
        !entry.entryName.startsWith('__MACOSX/'),
    )
    .sort(
      (left, right) =>
        Number(left.entryName.split('/')[2]) - Number(right.entryName.split('/')[2]),
    )

  const noiseRaw = mergeFeatureCollections(
    noiseEntries.map((entry) => {
      const folder = entry.entryName.split('/')[2]
      const source = NOISE_SOURCE_BY_FOLDER[folder] ?? `noise_${folder}`
      return tagFeatures(
        reprojectFeatureCollection(
          JSON.parse(stripBom(entry.getData().toString('utf8'))),
          'PL_CS2000_ZONE_7',
          'EPSG:4326',
        ),
        { noise_source: source },
      )
    }),
  )

  const bikeRacks = mapPointFeatures(
    flattenByGeometry(bikeRacksRaw, ['Point', 'MultiPoint']),
    'rack',
  )
  const bikeInfrastructure = mapPointFeatures(
    flattenByGeometry(bikeInfrastructureRaw, ['Point', 'MultiPoint']),
    'infrastructure',
  )
  const cyclingPaths = mapCyclingPathFeatures(
    flattenByGeometry(cyclingPathsRaw, ['LineString', 'MultiLineString']),
  )
  const greenery = mapGreeneryFeatures(
    flattenByGeometry(greeneryRaw, ['Polygon', 'MultiPolygon']),
  )
  const noise = mapNoiseFeatures(flattenByGeometry(noiseRaw, ['Polygon', 'MultiPolygon']))

  return {
    bikeRacks,
    bikeInfrastructure,
    cyclingPaths,
    greenery,
    noise,
  }
}

function scoreCyclingSegments(datasets) {
  const { bikeRacks, bikeInfrastructure, cyclingPaths, greenery, noise } = datasets
  const bikeRackIndex = buildFeatureIndex(bikeRacks.features)
  const bikeInfrastructureIndex = buildFeatureIndex(bikeInfrastructure.features)
  const greeneryIndex = buildFeatureIndex(greenery.features)
  const noiseIndex = buildFeatureIndex(noise.features)

  const features = []

  for (const [index, feature] of cyclingPaths.features.entries()) {
    if ((index + 1) % 250 === 0 || index === 0) {
      console.log(`Scoring segment ${index + 1}/${cyclingPaths.features.length}...`)
    }

    const lengthKm = safeLength(feature)
    const corridorSamples = buildCorridorSamples(feature, lengthKm)

    const nearestRackDistanceM = findNearestPointDistanceToLine(
      bikeRacks.features,
      bikeRackIndex,
      feature,
    )
    const nearestInfraDistanceM = findNearestPointDistanceToLine(
      bikeInfrastructure.features,
      bikeInfrastructureIndex,
      feature,
    )
    const greeneryRatio = computeGreeneryRatio(
      corridorSamples,
      greeneryIndex,
      greenery.features,
    )
    const maxNoiseDb = computeMaxNoise(corridorSamples, noiseIndex, noise.features)
    const scoreBreakdown = computeScoreBreakdown({
      greeneryRatio,
      maxNoiseDb,
      nearestRackDistanceM,
      nearestInfraDistanceM,
    })
    const center = safePointOnFeature(feature)

    features.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        segment_id: index + 1,
        kind: cleanText(feature.properties?.kind),
        surface: cleanText(feature.properties?.surface),
        length_km: round(lengthKm, 3),
        nearest_rack_m: roundNullable(nearestRackDistanceM, 2),
        nearest_infra_m: roundNullable(nearestInfraDistanceM, 2),
        greenery_ratio: round(greeneryRatio, 4),
        max_noise_db: roundNullable(maxNoiseDb, 2),
        greenery_score: round(scoreBreakdown.greenery.score, 2),
        noise_score: round(scoreBreakdown.noise.score, 2),
        rack_score: round(scoreBreakdown.rack.score, 2),
        infrastructure_score: round(scoreBreakdown.infrastructure.score, 2),
        greenery_points: round(scoreBreakdown.greenery.points, 2),
        noise_points: round(scoreBreakdown.noise.points, 2),
        rack_points: round(scoreBreakdown.rack.points, 2),
        infrastructure_points: round(scoreBreakdown.infrastructure.points, 2),
        comfort_score: round(scoreBreakdown.total, 2),
        score: round(scoreBreakdown.total, 2),
        center,
        is_top_segment: false,
        score_rank: null,
      },
    })
  }

  const ranked = [...features].sort(compareSegmentRank)

  ranked.forEach((feature, rank) => {
    feature.properties.score_rank = rank + 1
    feature.properties.is_top_segment = rank < TOP_SEGMENT_COUNT
  })

  return {
    type: 'FeatureCollection',
    features,
  }
}

function buildPointsLayer(datasets) {
  const features = [...datasets.bikeRacks.features, ...datasets.bikeInfrastructure.features].sort(
    (left, right) => {
      const kindDelta = String(left.properties.point_kind).localeCompare(
        String(right.properties.point_kind),
      )
      if (kindDelta !== 0) {
        return kindDelta
      }
      return (left.properties.point_id ?? 0) - (right.properties.point_id ?? 0)
    },
  )

  return {
    type: 'FeatureCollection',
    features,
  }
}

function buildHexesLayer(cells) {
  return {
    type: 'FeatureCollection',
    features: cells.map((cell) => ({
      type: 'Feature',
      geometry: cell.geometry,
      properties: {
        h3_index: cell.h3_index,
        h3_resolution: cell.h3_resolution,
        center: cell.center,
        bounds: cell.bounds,
        hex_score: cell.hex_score,
        demand_score: cell.demand_score,
        network_score: cell.network_score,
        quality_score: cell.quality_score,
        demand_weight: cell.demand_weight,
        point_count: cell.point_count,
        rack_count: cell.rack_count,
        infrastructure_count: cell.infrastructure_count,
        segment_sample_count: cell.segment_sample_count,
        covered_segment_count: cell.covered_segment_count,
        mean_segment_score: cell.mean_segment_score,
        mean_greenery_ratio: cell.mean_greenery_ratio,
        max_noise_db: cell.max_noise_db,
      },
    })),
  }
}

function buildHotspotsLayer(hotspots) {
  return {
    type: 'FeatureCollection',
    features: hotspots.map((hotspot) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: hotspot.center,
      },
      properties: {
        hub_id: hotspot.hub_id,
        label: hotspot.label,
        cell_id: hotspot.cell_id,
        h3_index: hotspot.h3_index,
        h3_resolution: hotspot.h3_resolution,
        center: hotspot.center,
        density_score: hotspot.density_score,
        hex_score: hotspot.hex_score,
        demand_score: hotspot.demand_score,
        network_score: hotspot.network_score,
        quality_score: hotspot.quality_score,
        total_weight: hotspot.total_weight,
        point_count: hotspot.point_count,
        rack_count: hotspot.rack_count,
        infrastructure_count: hotspot.infrastructure_count,
        mean_segment_score: hotspot.mean_segment_score,
        graph_node_id: hotspot.graph_node_id,
        component_id: hotspot.component_id,
        snap_distance_m: hotspot.snap_distance_m,
      },
    })),
  }
}

function buildCorridorsLayer(corridors) {
  return {
    type: 'FeatureCollection',
    features: corridors.map((corridor) => ({
      type: 'Feature',
      geometry: corridor.geometry,
      properties: {
        corridor_id: corridor.corridor_id,
        corridor_rank: corridor.corridor_rank,
        label: corridor.label,
        from_hub_id: corridor.from_hub_id,
        to_hub_id: corridor.to_hub_id,
        from_label: corridor.from_label,
        to_label: corridor.to_label,
        from_h3_index: corridor.from_h3_index,
        to_h3_index: corridor.to_h3_index,
        direct_distance_km: corridor.direct_distance_km,
        path_length_km: corridor.path_length_km,
        path_cost: corridor.path_cost,
        pair_priority: corridor.pair_priority,
        segment_count: corridor.segment_count,
        mean_segment_score: corridor.mean_segment_score,
        min_segment_score: corridor.min_segment_score,
        mean_h3_score: corridor.mean_h3_score,
        min_h3_score: corridor.min_h3_score,
        max_noise_db: corridor.max_noise_db,
        mean_greenery_ratio: corridor.mean_greenery_ratio,
        mean_rack_distance_m: corridor.mean_rack_distance_m,
        mean_infrastructure_distance_m: corridor.mean_infrastructure_distance_m,
        center: corridor.center,
        bounds: corridor.bounds,
      },
    })),
  }
}

function buildConnectorsLayer(connectors) {
  return {
    type: 'FeatureCollection',
    features: connectors.map((connector) => ({
      type: 'Feature',
      geometry: connector.geometry,
      properties: {
        connector_id: connector.connector_id,
        connector_rank: connector.connector_rank,
        label: connector.label,
        source_component_id: connector.source_component_id,
        target_component_id: connector.target_component_id,
        source_component_label: connector.source_component_label,
        target_component_label: connector.target_component_label,
        source_node_id: connector.source_node_id,
        target_node_id: connector.target_node_id,
        length_m: connector.length_m,
        length_km: connector.length_km,
        demand_gain_points: connector.demand_gain_points,
        network_gain_points: connector.network_gain_points,
        distance_points: connector.distance_points,
        environment_points: connector.environment_points,
        crossing_penalty_points: connector.crossing_penalty_points,
        priority_score: connector.priority_score,
        greenery_ratio: connector.greenery_ratio,
        max_noise_db: connector.max_noise_db,
        noise_score: connector.noise_score,
        network_crossings_count: connector.network_crossings_count,
        source_component_demand_weight: connector.source_component_demand_weight,
        target_component_demand_weight: connector.target_component_demand_weight,
        target_component_nodes: connector.target_component_nodes,
        target_component_edges: connector.target_component_edges,
        center: connector.center,
        bounds: connector.bounds,
      },
    })),
  }
}

function buildCyclingGraph(scoredSegments, cellScoreByIndex) {
  const nodeByKey = new Map()
  const nodes = []
  const edges = []
  let selfLoopEdges = 0

  for (const feature of scoredSegments.features) {
    const coordinates = feature.geometry?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      continue
    }

    const start = normalizeCoordinates(coordinates[0])
    const end = normalizeCoordinates(coordinates[coordinates.length - 1])

    if (!isCoordinate(start) || !isCoordinate(end)) {
      continue
    }

    const startNode = getOrCreateGraphNode(nodeByKey, nodes, start)
    const endNode = getOrCreateGraphNode(nodeByKey, nodes, end)
    const lengthM = Math.max(1, Number(feature.properties.length_km ?? 0) * 1000)
    const midpoint = isCoordinate(feature.properties.center)
      ? feature.properties.center
      : safePointOnFeature(feature)
    const edgeH3Index = isCoordinate(midpoint) ? coordinateToH3(midpoint) : null
    const edgeH3Score =
      edgeH3Index == null
        ? round(Number(feature.properties.score ?? 0), 2)
        : round(
            Number(
              cellScoreByIndex?.get(edgeH3Index) ??
                Number(feature.properties.score ?? 0),
            ),
            2,
          )

    edges.push({
      edge_id: edges.length + 1,
      segment_id: feature.properties.segment_id,
      start_node_id: startNode.node_id,
      end_node_id: endNode.node_id,
      coordinates,
      length_m: round(lengthM, 2),
      edge_cost: round(computeEdgeTravelCost(lengthM, edgeH3Score), 4),
      segment_score: round(Number(feature.properties.score ?? 0), 2),
      edge_h3_index: edgeH3Index,
      edge_h3_score: edgeH3Score,
    })

    if (startNode.node_id === endNode.node_id) {
      selfLoopEdges += 1
    }
  }

  const adjacency = Array.from({ length: nodes.length + 1 }, () => [])

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

  const componentAnalysis = computeGraphComponents(nodes, adjacency)
  const totalNetworkLengthKm = edges.reduce((total, edge) => total + edge.length_m, 0) / 1000
  const averageDegree =
    nodes.length === 0
      ? 0
      : adjacency.slice(1).reduce((total, neighbors) => total + neighbors.length, 0) / nodes.length

  return {
    nodes,
    edges,
    adjacency,
    node_index: buildNodeIndex(nodes),
    node_component_id_by_node_id: componentAnalysis.node_component_id_by_node_id,
    largest_component_id: componentAnalysis.largest_component_id,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      self_loop_edges: selfLoopEdges,
      connected_components: componentAnalysis.component_count,
      largest_component_nodes: componentAnalysis.largest_component_nodes,
      largest_component_edges: componentAnalysis.largest_component_edges,
      average_degree: round(averageDegree, 2),
      total_network_length_km: round(totalNetworkLengthKm, 2),
    },
  }
}

function getOrCreateGraphNode(nodeByKey, nodes, coordinate) {
  const key = coordinateKey(coordinate)
  const existing = nodeByKey.get(key)

  if (existing) {
    return existing
  }

  const node = {
    node_id: nodes.length + 1,
    coordinate: [round(coordinate[0], 6), round(coordinate[1], 6)],
  }

  nodeByKey.set(key, node)
  nodes.push(node)
  return node
}

function coordinateKey(coordinate) {
  return `${coordinate[0].toFixed(GRAPH_SNAP_DECIMALS)}:${coordinate[1].toFixed(GRAPH_SNAP_DECIMALS)}`
}

function buildNodeIndex(nodes) {
  const tree = new RBush()

  nodes.forEach((node) => {
    tree.insert({
      minX: node.coordinate[0],
      minY: node.coordinate[1],
      maxX: node.coordinate[0],
      maxY: node.coordinate[1],
      node_id: node.node_id,
    })
  })

  return tree
}

function computeGraphComponents(nodes, adjacency) {
  const visited = new Set()
  const nodeComponentIdByNodeId = {}
  let componentCount = 0
  let largestComponentNodes = 0
  let largestComponentEdges = 0
  let largestComponentId = 0

  for (const node of nodes) {
    if (visited.has(node.node_id)) {
      continue
    }

    componentCount += 1
    const queue = [node.node_id]
    visited.add(node.node_id)
    let nodeCount = 0
    let edgeVisits = 0

    while (queue.length > 0) {
      const currentNodeId = queue.shift()
      nodeCount += 1
      nodeComponentIdByNodeId[currentNodeId] = componentCount

      for (const neighbor of adjacency[currentNodeId]) {
        edgeVisits += 1

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
      largestComponentEdges = Math.round(edgeVisits / 2)
    }
  }

  return {
    component_count: componentCount,
    largest_component_id: largestComponentId,
    largest_component_nodes: largestComponentNodes,
    largest_component_edges: largestComponentEdges,
    node_component_id_by_node_id: nodeComponentIdByNodeId,
  }
}

function computeEdgeTravelCost(lengthM, segmentScore) {
  const normalizedScore = clamp(Number(segmentScore ?? 0), 0, 100)
  return lengthM * (1 + (100 - normalizedScore) / 100)
}

function buildH3Analysis(datasets, scoredSegments) {
  const cellsByIndex = new Map()

  const ensureCell = (cellIndex) => {
    const existing = cellsByIndex.get(cellIndex)
    if (existing) {
      return existing
    }

    const cell = {
      h3_index: cellIndex,
      h3_resolution: H3_RESOLUTION,
      demand_weight: 0,
      point_count: 0,
      rack_count: 0,
      infrastructure_count: 0,
      segment_sample_count: 0,
      covered_segment_count: 0,
      segment_score_total: 0,
      greenery_ratio_total: 0,
      noise_sample_count: 0,
      noise_max: null,
      mean_segment_score: 0,
      mean_greenery_ratio: 0,
      max_noise_db: null,
      demand_score: 0,
      network_score: 0,
      quality_score: 0,
      hex_score: 0,
    }

    cellsByIndex.set(cellIndex, cell)
    return cell
  }

  for (const point of extractDemandPoints(datasets)) {
    const cell = ensureCell(coordinateToH3(point.coordinate))
    cell.demand_weight += point.weight
    cell.point_count += 1

    if (point.point_kind === 'rack') {
      cell.rack_count += 1
    } else {
      cell.infrastructure_count += 1
    }
  }

  for (const feature of scoredSegments.features) {
    const segmentId = Number(feature.properties.segment_id ?? 0)
    const lengthKm = Number(feature.properties.length_km ?? 0)
    const samples = buildCorridorSamples(feature, lengthKm)
    const seenCells = new Set()

    for (const sample of samples) {
      const coordinates = normalizeCoordinates(sample.point.geometry?.coordinates)
      if (!isCoordinate(coordinates)) {
        continue
      }

      const cell = ensureCell(coordinateToH3(coordinates))
      cell.segment_sample_count += 1
      cell.segment_score_total += Number(feature.properties.score ?? 0)
      cell.greenery_ratio_total += Number(feature.properties.greenery_ratio ?? 0)

      const noiseValue = toFiniteNumber(feature.properties.max_noise_db)
      if (noiseValue != null) {
        cell.noise_sample_count += 1
        cell.noise_max = cell.noise_max == null ? noiseValue : Math.max(cell.noise_max, noiseValue)
      }

      if (!seenCells.has(cell.h3_index) && segmentId > 0) {
        seenCells.add(cell.h3_index)
        cell.covered_segment_count += 1
      }
    }
  }

  const rawCells = [...cellsByIndex.values()]
  const maxDemandWeight = Math.max(0, ...rawCells.map((cell) => cell.demand_weight))
  const maxSegmentSampleCount = Math.max(0, ...rawCells.map((cell) => cell.segment_sample_count))

  const cells = rawCells
    .map((cell) => {
      const meanSegmentScore =
        cell.segment_sample_count === 0 ? 0 : cell.segment_score_total / cell.segment_sample_count
      const meanGreeneryRatio =
        cell.segment_sample_count === 0 ? 0 : cell.greenery_ratio_total / cell.segment_sample_count
      const demandScore = normalizeScore(cell.demand_weight, maxDemandWeight)
      const networkScore = normalizeScore(cell.segment_sample_count, maxSegmentSampleCount)
      const qualityScore = clamp(meanSegmentScore, 0, 100)
      const hexScore = clamp(
        demandScore * H3_SCORE_WEIGHTS.demand +
          networkScore * H3_SCORE_WEIGHTS.network +
          qualityScore * H3_SCORE_WEIGHTS.quality,
        0,
        100,
      )
      const center = h3IndexToCoordinate(cell.h3_index)
      const geometry = h3IndexToPolygonGeometry(cell.h3_index)

      return {
        ...cell,
        center,
        geometry,
        bounds: geometryCoordinatesBounds(geometry.coordinates),
        mean_segment_score: round(meanSegmentScore, 2),
        mean_greenery_ratio: round(meanGreeneryRatio, 4),
        max_noise_db: roundNullable(cell.noise_max, 2),
        demand_score: round(demandScore, 2),
        network_score: round(networkScore, 2),
        quality_score: round(qualityScore, 2),
        hex_score: round(hexScore, 2),
        demand_weight: round(cell.demand_weight, 2),
      }
    })
    .sort((left, right) => {
      const scoreDelta = right.hex_score - left.hex_score
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      const demandDelta = right.demand_weight - left.demand_weight
      if (demandDelta !== 0) {
        return demandDelta
      }

      return left.h3_index.localeCompare(right.h3_index)
    })

  return {
    cells,
    cell_score_by_index: new Map(cells.map((cell) => [cell.h3_index, cell.hex_score])),
  }
}

function buildH3RouteHubs(cells, graph) {
  const hubCandidates = []

  for (const cell of cells) {
    if (cell.point_count === 0) {
      continue
    }

    const snappedNode = findNearestNode(
      cell.center,
      graph.node_index,
      graph.nodes,
      H3_MAX_NODE_DISTANCE_METERS,
    )

    if (!snappedNode) {
      continue
    }

    hubCandidates.push({
      center: cell.center,
      cell_id: cell.h3_index,
      h3_index: cell.h3_index,
      h3_resolution: cell.h3_resolution,
      density_score: cell.hex_score,
      hex_score: cell.hex_score,
      demand_score: cell.demand_score,
      network_score: cell.network_score,
      quality_score: cell.quality_score,
      mean_segment_score: cell.mean_segment_score,
      total_weight: cell.demand_weight,
      point_count: cell.point_count,
      rack_count: cell.rack_count,
      infrastructure_count: cell.infrastructure_count,
      graph_node_id: snappedNode.node_id,
      snap_distance_m: round(snappedNode.distance_m, 2),
      component_id: graph.node_component_id_by_node_id[snappedNode.node_id] ?? null,
    })
  }

  const largestComponentCandidates = hubCandidates.filter(
    (candidate) => candidate.component_id === graph.largest_component_id,
  )
  const selectionPool =
    largestComponentCandidates.length >= 2 ? largestComponentCandidates : hubCandidates
  const hubs = []

  for (const candidate of selectionPool) {
    const tooClose = hubs.some(
      (existing) =>
        coordinateDistanceMeters(existing.center, candidate.center) < H3_MIN_HUB_DISTANCE_METERS,
    )

    if (tooClose) {
      continue
    }

    hubs.push({
      ...candidate,
      hub_id: hubs.length + 1,
      label: `H3 Hub ${hubs.length + 1}`,
    })

    if (hubs.length >= H3_HUB_COUNT) {
      break
    }
  }

  return hubs
}

function coordinateToH3(coordinate) {
  return h3.latLngToCell(coordinate[1], coordinate[0], H3_RESOLUTION)
}

function h3IndexToCoordinate(h3Index) {
  const [latitude, longitude] = h3.cellToLatLng(h3Index)
  return [round(longitude, 6), round(latitude, 6)]
}

function h3IndexToPolygonGeometry(h3Index) {
  const boundary = h3
    .cellToBoundary(h3Index)
    .map(([latitude, longitude]) => [round(longitude, 6), round(latitude, 6)])

  return {
    type: 'Polygon',
    coordinates: [[...boundary, boundary[0]]],
  }
}

function geometryCoordinatesBounds(coordinates) {
  const flatCoordinates = []

  collectCoordinates(coordinates, flatCoordinates)

  return coordinatesBounds(flatCoordinates)
}

function collectCoordinates(coordinates, target) {
  if (!Array.isArray(coordinates)) {
    return
  }

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    target.push([coordinates[0], coordinates[1]])
    return
  }

  coordinates.forEach((item) => collectCoordinates(item, target))
}

function extractDemandPoints(datasets) {
  return [...datasets.bikeRacks.features, ...datasets.bikeInfrastructure.features]
    .map((feature) => {
      const coordinate = normalizeCoordinates(feature.geometry?.coordinates)
      if (!isCoordinate(coordinate)) {
        return null
      }

      const pointKind = feature.properties?.point_kind
      const baseWeight =
        pointKind === 'infrastructure'
          ? DEMAND_POINT_WEIGHTS.infrastructure
          : DEMAND_POINT_WEIGHTS.rack
      const countWeight = Math.max(1, Number(feature.properties?.count ?? 1))

      return {
        coordinate,
        point_kind: pointKind,
        weight: baseWeight * countWeight,
      }
    })
    .filter(Boolean)
}

function buildComponentSummaries(graph, datasets) {
  const summariesByComponentId = new Map()

  graph.nodes.forEach((node) => {
    const componentId = graph.node_component_id_by_node_id[node.node_id]
    if (componentId == null) {
      return
    }

    const summary =
      summariesByComponentId.get(componentId) ??
      createComponentSummary(componentId)

    summary.node_ids.push(node.node_id)
    summary.node_coordinates.push(node.coordinate)
    summary.node_count += 1
    summariesByComponentId.set(componentId, summary)
  })

  graph.edges.forEach((edge) => {
    const componentId = graph.node_component_id_by_node_id[edge.start_node_id]
    if (componentId == null) {
      return
    }

    const summary =
      summariesByComponentId.get(componentId) ??
      createComponentSummary(componentId)

    summary.edge_count += 1
    summary.total_edge_length_km += edge.length_m / 1000
    summariesByComponentId.set(componentId, summary)
  })

  const demandPoints = extractDemandPoints(datasets)

  demandPoints.forEach((point) => {
    const snappedNode = findNearestNode(
      point.coordinate,
      graph.node_index,
      graph.nodes,
      H3_MAX_NODE_DISTANCE_METERS,
    )

    if (!snappedNode) {
      return
    }

    const componentId = graph.node_component_id_by_node_id[snappedNode.node_id]
    if (componentId == null) {
      return
    }

    const summary =
      summariesByComponentId.get(componentId) ??
      createComponentSummary(componentId)

    summary.demand_weight += point.weight
    summary.demand_point_count += 1

    if (point.point_kind === 'rack') {
      summary.rack_count += 1
    } else {
      summary.infrastructure_count += 1
    }

    summariesByComponentId.set(componentId, summary)
  })

  return [...summariesByComponentId.values()]
    .map((summary) => ({
      ...summary,
      label:
        summary.component_id === graph.largest_component_id
          ? `Component ${summary.component_id} (largest)`
          : `Component ${summary.component_id}`,
      center: computeMeanCenter(summary.node_coordinates),
      bounds: coordinatesBounds(summary.node_coordinates),
      total_edge_length_km: round(summary.total_edge_length_km, 2),
      demand_weight: round(summary.demand_weight, 2),
    }))
    .sort((left, right) => {
      const demandDelta = right.demand_weight - left.demand_weight
      if (demandDelta !== 0) {
        return demandDelta
      }

      const nodeDelta = right.node_count - left.node_count
      if (nodeDelta !== 0) {
        return nodeDelta
      }

      return left.component_id - right.component_id
    })
}

function createComponentSummary(componentId) {
  return {
    component_id: componentId,
    node_ids: [],
    node_coordinates: [],
    node_count: 0,
    edge_count: 0,
    total_edge_length_km: 0,
    demand_weight: 0,
    demand_point_count: 0,
    rack_count: 0,
    infrastructure_count: 0,
  }
}

function computeGaussianDensityScore(center, points, bandwidthMeters) {
  let score = 0

  for (const point of points) {
    const distance = coordinateDistanceMeters(center, point.coordinate)
    const influence = Math.exp(-(distance * distance) / (2 * bandwidthMeters * bandwidthMeters))
    score += point.weight * influence
  }

  return score
}

function findNearestNode(coordinate, nodeIndex, nodes, maxDistanceMeters) {
  let searchMeters = 150
  let best = null

  while (searchMeters <= maxDistanceMeters) {
    const candidates = nodeIndex.search(
      expandSearchItem([coordinate[0], coordinate[1], coordinate[0], coordinate[1]], searchMeters),
    )

    for (const candidate of candidates) {
      const node = nodes[candidate.node_id - 1]
      const distance = coordinateDistanceMeters(coordinate, node.coordinate)

      if (distance > maxDistanceMeters) {
        continue
      }

      if (!best || distance < best.distance_m) {
        best = {
          node_id: node.node_id,
          distance_m: distance,
        }
      }
    }

    if (best) {
      return best
    }

    searchMeters *= 2
  }

  return null
}

function buildCorridorRecommendations(scoredSegments, graph, hotspots) {
  const segmentById = new Map(
    scoredSegments.features.map((feature) => [feature.properties.segment_id, feature]),
  )
  const pairCandidates = []

  for (let leftIndex = 0; leftIndex < hotspots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < hotspots.length; rightIndex += 1) {
      const fromHub = hotspots[leftIndex]
      const toHub = hotspots[rightIndex]

      if (fromHub.component_id == null || fromHub.component_id !== toHub.component_id) {
        continue
      }

      const directDistanceMeters = coordinateDistanceMeters(fromHub.center, toHub.center)

      if (directDistanceMeters < MIN_CORRIDOR_DISTANCE_METERS) {
        continue
      }

      pairCandidates.push({
        from_hub: fromHub,
        to_hub: toHub,
        direct_distance_m: directDistanceMeters,
        direct_distance_km: directDistanceMeters / 1000,
        pair_priority: (fromHub.hex_score + toHub.hex_score) * (directDistanceMeters / 1000),
      })
    }
  }

  pairCandidates.sort((left, right) => {
    const priorityDelta = right.pair_priority - left.pair_priority
    if (priorityDelta !== 0) {
      return priorityDelta
    }

    return `${left.from_hub.hub_id}:${left.to_hub.hub_id}`.localeCompare(
      `${right.from_hub.hub_id}:${right.to_hub.hub_id}`,
    )
  })

  const corridors = []
  const seenSignatures = new Set()
  const segmentUsageBySegmentId = {}

  for (const candidate of pairCandidates) {
    const path = shortestPath(graph, candidate.from_hub.graph_node_id, candidate.to_hub.graph_node_id)

    if (!path || path.segment_ids.length === 0) {
      continue
    }

    const signature = path.segment_ids.join(',')
    if (seenSignatures.has(signature)) {
      continue
    }

    seenSignatures.add(signature)

    const corridor = summarizeCorridor(
      corridors.length + 1,
      candidate,
      path,
      graph.edges,
      segmentById,
    )

    corridor.segment_ids.forEach((segmentId) => {
      segmentUsageBySegmentId[segmentId] = (segmentUsageBySegmentId[segmentId] ?? 0) + 1
    })

    corridors.push(corridor)

    if (corridors.length >= RECOMMENDED_CORRIDOR_COUNT) {
      break
    }
  }

  return {
    hotspots,
    corridors,
    segmentUsageBySegmentId,
  }
}

function buildOffNetworkConnectors(datasets, scoredSegments, graph, componentSummaries) {
  const sourceComponent = componentSummaries.find(
    (summary) => summary.component_id === graph.largest_component_id,
  )

  if (!sourceComponent) {
    return { connectors: [] }
  }

  const greeneryIndex = buildFeatureIndex(datasets.greenery.features)
  const noiseIndex = buildFeatureIndex(datasets.noise.features)
  const segmentIndex = buildFeatureIndex(scoredSegments.features)
  const maxDemandWeight = Math.max(0, ...componentSummaries.map((summary) => summary.demand_weight))
  const maxNodeCount = Math.max(0, ...componentSummaries.map((summary) => summary.node_count))
  const maxEdgeCount = Math.max(0, ...componentSummaries.map((summary) => summary.edge_count))

  const targetComponents = componentSummaries
    .filter((summary) => summary.component_id !== sourceComponent.component_id)
    .filter((summary) => summary.node_count > 0)
    .filter((summary) => summary.demand_weight > 0 || summary.edge_count > 0)
    .slice(0, CONNECTOR_TARGET_COMPONENT_LIMIT)

  const connectors = []

  for (const targetComponent of targetComponents) {
    const nodePair = findClosestNodePairBetweenComponents(graph, sourceComponent, targetComponent)
    if (!nodePair) {
      continue
    }

    if (
      nodePair.distance_m < MIN_CONNECTOR_LENGTH_METERS ||
      nodePair.distance_m > MAX_CONNECTOR_LENGTH_METERS
    ) {
      continue
    }

    const connector = summarizeOffNetworkConnector(
      connectors.length + 1,
      nodePair,
      sourceComponent,
      targetComponent,
      datasets,
      greeneryIndex,
      noiseIndex,
      segmentIndex,
      scoredSegments.features,
      {
        maxDemandWeight,
        maxNodeCount,
        maxEdgeCount,
      },
    )

    connectors.push(connector)

    if (connectors.length >= RECOMMENDED_CONNECTOR_COUNT) {
      break
    }
  }

  connectors.sort((left, right) => {
    const priorityDelta = right.priority_score - left.priority_score
    if (priorityDelta !== 0) {
      return priorityDelta
    }

    return left.target_component_id - right.target_component_id
  })

  connectors.forEach((connector, index) => {
    connector.connector_rank = index + 1
  })

  return {
    connectors,
  }
}

function findClosestNodePairBetweenComponents(graph, sourceComponent, targetComponent) {
  const sourceNodes = sourceComponent.node_ids.map((nodeId) => graph.nodes[nodeId - 1]).filter(Boolean)
  const targetNodes = targetComponent.node_ids.map((nodeId) => graph.nodes[nodeId - 1]).filter(Boolean)

  if (sourceNodes.length === 0 || targetNodes.length === 0) {
    return null
  }

  let best = null

  for (const sourceNode of sourceNodes) {
    for (const targetNode of targetNodes) {
      const distanceM = coordinateDistanceMeters(sourceNode.coordinate, targetNode.coordinate)

      if (distanceM > MAX_CONNECTOR_LENGTH_METERS) {
        continue
      }

      if (!best || distanceM < best.distance_m) {
        best = {
          source_node_id: sourceNode.node_id,
          target_node_id: targetNode.node_id,
          source_coordinate: sourceNode.coordinate,
          target_coordinate: targetNode.coordinate,
          distance_m: distanceM,
        }
      }
    }
  }

  return best
}

function summarizeOffNetworkConnector(
  connectorId,
  nodePair,
  sourceComponent,
  targetComponent,
  datasets,
  greeneryIndex,
  noiseIndex,
  segmentIndex,
  segmentFeatures,
  normalization,
) {
  const connectorFeature = turf.lineString([nodePair.source_coordinate, nodePair.target_coordinate])
  const lengthKm = nodePair.distance_m / 1000
  const samples = buildCorridorSamples(connectorFeature, lengthKm)
  const greeneryRatio = computeGreeneryRatio(samples, greeneryIndex, datasets.greenery.features)
  const maxNoiseDb = computeMaxNoise(samples, noiseIndex, datasets.noise.features)
  const noiseScore =
    maxNoiseDb == null
      ? SCORE_REFERENCES.noiseDb.missingScore
      : scaleDescending(maxNoiseDb, SCORE_REFERENCES.noiseDb.best, SCORE_REFERENCES.noiseDb.worst)
  const crossingsCount = countConnectorCrossings(
    connectorFeature,
    segmentIndex,
    segmentFeatures,
    nodePair.source_coordinate,
    nodePair.target_coordinate,
  )

  const demandGainPoints =
    normalizeScore(targetComponent.demand_weight, normalization.maxDemandWeight) * 0.45
  const networkGainPoints =
    normalizeScore(targetComponent.node_count, normalization.maxNodeCount) * 0.15 +
    normalizeScore(targetComponent.edge_count, normalization.maxEdgeCount) * 0.1
  const distancePoints =
    scaleDescending(nodePair.distance_m, MIN_CONNECTOR_LENGTH_METERS, MAX_CONNECTOR_LENGTH_METERS) *
    0.2
  const environmentPoints = greeneryRatio * 10 + noiseScore * 0.1
  const crossingPenaltyPoints = Math.min(crossingsCount * 3, 15)
  const priorityScore = clamp(
    demandGainPoints +
      networkGainPoints +
      distancePoints +
      environmentPoints -
      crossingPenaltyPoints,
    0,
    100,
  )

  return {
    connector_id: connectorId,
    connector_rank: connectorId,
    label: `${sourceComponent.label} -> ${targetComponent.label}`,
    source_component_id: sourceComponent.component_id,
    target_component_id: targetComponent.component_id,
    source_component_label: sourceComponent.label,
    target_component_label: targetComponent.label,
    source_node_id: nodePair.source_node_id,
    target_node_id: nodePair.target_node_id,
    length_m: round(nodePair.distance_m, 2),
    length_km: round(lengthKm, 3),
    demand_gain_points: round(demandGainPoints, 2),
    network_gain_points: round(networkGainPoints, 2),
    distance_points: round(distancePoints, 2),
    environment_points: round(environmentPoints, 2),
    crossing_penalty_points: round(crossingPenaltyPoints, 2),
    priority_score: round(priorityScore, 2),
    greenery_ratio: round(greeneryRatio, 4),
    max_noise_db: roundNullable(maxNoiseDb, 2),
    noise_score: round(noiseScore, 2),
    network_crossings_count: crossingsCount,
    source_component_demand_weight: sourceComponent.demand_weight,
    target_component_demand_weight: targetComponent.demand_weight,
    target_component_nodes: targetComponent.node_count,
    target_component_edges: targetComponent.edge_count,
    center: safePointOnFeature(connectorFeature),
    bounds: safeBbox(connectorFeature),
    geometry: connectorFeature.geometry,
  }
}

function countConnectorCrossings(
  connectorFeature,
  segmentIndex,
  segmentFeatures,
  sourceCoordinate,
  targetCoordinate,
) {
  const connectorBounds = safeBbox(connectorFeature)
  if (!connectorBounds) {
    return 0
  }

  const candidates = segmentIndex
    .search(bboxToSearchItem(connectorBounds))
    .map((item) => segmentFeatures[item.featureIndex])

  let crossingsCount = 0

  for (const candidate of candidates) {
    const intersections = safeLineIntersections(connectorFeature, candidate)
    if (intersections.length === 0) {
      continue
    }

    const hasInteriorIntersection = intersections.some((intersection) => {
      const coordinate = normalizeCoordinates(intersection.geometry?.coordinates)
      if (!isCoordinate(coordinate)) {
        return false
      }

      return (
        coordinateDistanceMeters(coordinate, sourceCoordinate) >
          CONNECTOR_ENDPOINT_PROXIMITY_TOLERANCE_METERS &&
        coordinateDistanceMeters(coordinate, targetCoordinate) >
          CONNECTOR_ENDPOINT_PROXIMITY_TOLERANCE_METERS
      )
    })

    if (hasInteriorIntersection) {
      crossingsCount += 1
    }
  }

  return crossingsCount
}

function shortestPath(graph, startNodeId, targetNodeId) {
  if (!startNodeId || !targetNodeId || startNodeId === targetNodeId) {
    return null
  }

  const distances = new Array(graph.nodes.length + 1).fill(Number.POSITIVE_INFINITY)
  const previousNode = new Array(graph.nodes.length + 1).fill(null)
  const previousEdgeIndex = new Array(graph.nodes.length + 1).fill(null)
  const heap = new MinHeap()

  distances[startNodeId] = 0
  heap.push({ node_id: startNodeId, distance: 0 })

  while (!heap.isEmpty()) {
    const current = heap.pop()
    if (!current || current.distance > distances[current.node_id]) {
      continue
    }

    if (current.node_id === targetNodeId) {
      break
    }

    for (const neighbor of graph.adjacency[current.node_id]) {
      const nextDistance = current.distance + neighbor.cost

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

  const steps = []
  let cursor = targetNodeId

  while (cursor !== startNodeId) {
    const edgeIndex = previousEdgeIndex[cursor]
    const fromNodeId = previousNode[cursor]

    if (edgeIndex == null || fromNodeId == null) {
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

  return {
    total_cost: distances[targetNodeId],
    steps,
    segment_ids: steps.map((step) => graph.edges[step.edge_index].segment_id),
  }
}

function summarizeCorridor(corridorRank, candidate, path, edges, segmentById) {
  const traversedEdges = path.steps.map((step) => ({
    ...step,
    edge: edges[step.edge_index],
  }))
  const segmentFeatures = traversedEdges
    .map((step) => segmentById.get(step.edge.segment_id))
    .filter(Boolean)
  const geometry = buildCorridorGeometry(traversedEdges)
  const pathLengthKm =
    traversedEdges.reduce((total, step) => total + step.edge.length_m, 0) / 1000
  const scores = segmentFeatures.map((feature) => Number(feature.properties.score ?? 0))
  const h3Scores = traversedEdges
    .map((step) => toFiniteNumber(step.edge.edge_h3_score))
    .filter((value) => value != null)
  const greeneryRatios = segmentFeatures.map((feature) =>
    Number(feature.properties.greenery_ratio ?? 0),
  )
  const rackDistances = segmentFeatures
    .map((feature) => toFiniteNumber(feature.properties.nearest_rack_m))
    .filter((value) => value != null)
  const infrastructureDistances = segmentFeatures
    .map((feature) => toFiniteNumber(feature.properties.nearest_infra_m))
    .filter((value) => value != null)
  const noiseValues = segmentFeatures
    .map((feature) => toFiniteNumber(feature.properties.max_noise_db))
    .filter((value) => value != null)

  return {
    corridor_id: corridorRank,
    corridor_rank: corridorRank,
    label: `${candidate.from_hub.label} -> ${candidate.to_hub.label}`,
    from_hub_id: candidate.from_hub.hub_id,
    to_hub_id: candidate.to_hub.hub_id,
    from_label: candidate.from_hub.label,
    to_label: candidate.to_hub.label,
    from_h3_index: candidate.from_hub.h3_index,
    to_h3_index: candidate.to_hub.h3_index,
    direct_distance_km: round(candidate.direct_distance_km, 2),
    path_length_km: round(pathLengthKm, 2),
    path_cost: round(path.total_cost, 2),
    pair_priority: round(candidate.pair_priority, 2),
    segment_count: traversedEdges.length,
    mean_segment_score: round(mean(scores), 2),
    min_segment_score: round(scores.length === 0 ? 0 : Math.min(...scores), 2),
    mean_h3_score: round(h3Scores.length === 0 ? 0 : mean(h3Scores), 2),
    min_h3_score: round(h3Scores.length === 0 ? 0 : Math.min(...h3Scores), 2),
    max_noise_db: roundNullable(noiseValues.length === 0 ? null : Math.max(...noiseValues), 2),
    mean_greenery_ratio: round(mean(greeneryRatios), 4),
    mean_rack_distance_m: roundNullable(
      rackDistances.length === 0 ? null : mean(rackDistances),
      2,
    ),
    mean_infrastructure_distance_m: roundNullable(
      infrastructureDistances.length === 0 ? null : mean(infrastructureDistances),
      2,
    ),
    center: safePointOnFeature({ type: 'Feature', geometry, properties: {} }),
    bounds: safeBbox({ type: 'Feature', geometry, properties: {} }),
    segment_ids: traversedEdges.map((step) => step.edge.segment_id),
    geometry,
  }
}

function buildCorridorGeometry(traversedEdges) {
  const coordinates = []

  traversedEdges.forEach((step, index) => {
    const orientedCoordinates =
      step.edge.start_node_id === step.from_node_id
        ? step.edge.coordinates
        : [...step.edge.coordinates].reverse()

    if (index === 0) {
      coordinates.push(...orientedCoordinates)
      return
    }

    coordinates.push(...orientedCoordinates.slice(1))
  })

  return {
    type: 'LineString',
    coordinates: normalizeCoordinates(coordinates),
  }
}

function applyCorridorUsage(scoredSegments, segmentUsageBySegmentId) {
  scoredSegments.features.forEach((feature) => {
    feature.properties.corridor_usage_count =
      segmentUsageBySegmentId[feature.properties.segment_id] ?? 0
  })
}

function buildSpatialStatistics(datasets, scoredSegments, hotspots, bounds) {
  const rackCoordinates = datasets.bikeRacks.features
    .map((feature) => normalizeCoordinates(feature.geometry?.coordinates))
    .filter(isCoordinate)
  const infrastructureCoordinates = datasets.bikeInfrastructure.features
    .map((feature) => normalizeCoordinates(feature.geometry?.coordinates))
    .filter(isCoordinate)
  const segmentCenters = scoredSegments.features
    .map((feature) => feature.properties.center)
    .filter(isCoordinate)
  const hotspotCenters = hotspots.map((hotspot) => hotspot.center).filter(isCoordinate)
  const demandCoordinates = [...rackCoordinates, ...infrastructureCoordinates]

  return {
    bike_racks: summarizeSpatialPointSet(rackCoordinates, bounds),
    bike_infrastructure: summarizeSpatialPointSet(infrastructureCoordinates, bounds),
    demand_points: summarizeSpatialPointSet(demandCoordinates, bounds),
    segment_centers: summarizeSpatialPointSet(segmentCenters, bounds),
    hotspot_centers: summarizeSpatialPointSet(hotspotCenters, bounds),
  }
}

function summarizeSpatialPointSet(coordinates, bounds) {
  return {
    count: coordinates.length,
    mean_center: computeMeanCenter(coordinates),
    standard_deviational_ellipse: computeStandardDeviationalEllipse(coordinates),
    nearest_neighbor_index: computeNearestNeighborIndex(coordinates, bounds),
  }
}

function computeMeanCenter(coordinates) {
  if (coordinates.length === 0) {
    return null
  }

  return [
    round(mean(coordinates.map((coordinate) => coordinate[0])), 6),
    round(mean(coordinates.map((coordinate) => coordinate[1])), 6),
  ]
}

function computeStandardDeviationalEllipse(coordinates) {
  if (coordinates.length < 2) {
    return null
  }

  const center = computeMeanCenter(coordinates)
  const referenceLatitude = center[1]
  const projected = coordinates.map((coordinate) => projectCoordinate(coordinate, referenceLatitude))
  const meanX = mean(projected.map((value) => value.x))
  const meanY = mean(projected.map((value) => value.y))
  const sxx = mean(projected.map((value) => (value.x - meanX) ** 2))
  const syy = mean(projected.map((value) => (value.y - meanY) ** 2))
  const sxy = mean(projected.map((value) => (value.x - meanX) * (value.y - meanY)))
  const trace = sxx + syy
  const determinant = sxx * syy - sxy * sxy
  const term = Math.sqrt(Math.max(0, (trace * trace) / 4 - determinant))
  const majorVariance = trace / 2 + term
  const minorVariance = trace / 2 - term
  const rotationRadians = 0.5 * Math.atan2(2 * sxy, sxx - syy)

  return {
    center,
    major_axis_sd_m: round(Math.sqrt(Math.max(majorVariance, 0)), 2),
    minor_axis_sd_m: round(Math.sqrt(Math.max(minorVariance, 0)), 2),
    rotation_deg: round((rotationRadians * 180) / Math.PI, 2),
  }
}

function computeNearestNeighborIndex(coordinates, bounds) {
  if (coordinates.length < 2 || !bounds) {
    return null
  }

  const nearestNeighborDistances = []

  for (let index = 0; index < coordinates.length; index += 1) {
    let nearestDistance = Number.POSITIVE_INFINITY

    for (let candidateIndex = 0; candidateIndex < coordinates.length; candidateIndex += 1) {
      if (index === candidateIndex) {
        continue
      }

      const distance = coordinateDistanceMeters(
        coordinates[index],
        coordinates[candidateIndex],
      )

      if (distance < nearestDistance) {
        nearestDistance = distance
      }
    }

    if (Number.isFinite(nearestDistance)) {
      nearestNeighborDistances.push(nearestDistance)
    }
  }

  const observedMean = mean(nearestNeighborDistances)
  const area = approximateBoundsAreaSqMeters(bounds)

  if (!area || area <= 0) {
    return null
  }

  const expectedMean = 0.5 / Math.sqrt(coordinates.length / area)
  const nni = observedMean / expectedMean

  return {
    observed_mean_distance_m: round(observedMean, 2),
    expected_mean_distance_m: round(expectedMean, 2),
    nni: round(nni, 3),
    pattern:
      nni < 0.9 ? 'clustered' : nni > 1.1 ? 'dispersed' : 'near-random',
  }
}

function buildSummary(
  datasets,
  scoredSegments,
  graph,
  spatialStatistics,
  h3Analysis,
  corridorAnalysis,
  connectorAnalysis,
  componentSummaries,
) {
  const scores = scoredSegments.features
    .map((feature) => feature.properties.score)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)

  const topSegments = [...scoredSegments.features]
    .filter((feature) => feature.properties.is_top_segment)
    .sort((left, right) => (left.properties.score_rank ?? 0) - (right.properties.score_rank ?? 0))
    .map((feature) => ({
      segment_id: feature.properties.segment_id,
      score_rank: feature.properties.score_rank,
      score: feature.properties.score,
      comfort_score: feature.properties.comfort_score,
      kind: feature.properties.kind,
      surface: feature.properties.surface,
      length_km: feature.properties.length_km,
      greenery_ratio: feature.properties.greenery_ratio,
      max_noise_db: feature.properties.max_noise_db,
      nearest_rack_m: feature.properties.nearest_rack_m,
      nearest_infra_m: feature.properties.nearest_infra_m,
      greenery_score: feature.properties.greenery_score,
      noise_score: feature.properties.noise_score,
      rack_score: feature.properties.rack_score,
      infrastructure_score: feature.properties.infrastructure_score,
      greenery_points: feature.properties.greenery_points,
      noise_points: feature.properties.noise_points,
      rack_points: feature.properties.rack_points,
      infrastructure_points: feature.properties.infrastructure_points,
      center: feature.properties.center,
    }))

  return {
    bounds: safeBbox(scoredSegments),
    counts: {
      bike_racks: datasets.bikeRacks.features.length,
      bike_infrastructure_points: datasets.bikeInfrastructure.features.length,
      cycling_path_segments: scoredSegments.features.length,
      greenery_polygons: datasets.greenery.features.length,
      noise_polygons: datasets.noise.features.length,
    },
    score: {
      min: round(scores[0] ?? 0, 2),
      max: round(scores[scores.length - 1] ?? 0, 2),
      mean: round(mean(scores), 2),
      median: round(median(scores), 2),
    },
    spatial_statistics: spatialStatistics,
    h3_grid: {
      scenario: H3_SCENARIO,
      active_cells: h3Analysis.cells.length,
      hubs: corridorAnalysis.hotspots,
      top_cells: h3Analysis.cells.slice(0, H3_TOP_CELL_COUNT).map((cell) => ({
        h3_index: cell.h3_index,
        h3_resolution: cell.h3_resolution,
        center: cell.center,
        bounds: cell.bounds,
        hex_score: cell.hex_score,
        demand_score: cell.demand_score,
        network_score: cell.network_score,
        quality_score: cell.quality_score,
        demand_weight: cell.demand_weight,
        point_count: cell.point_count,
        rack_count: cell.rack_count,
        infrastructure_count: cell.infrastructure_count,
        segment_sample_count: cell.segment_sample_count,
        covered_segment_count: cell.covered_segment_count,
        mean_segment_score: cell.mean_segment_score,
        mean_greenery_ratio: cell.mean_greenery_ratio,
        max_noise_db: cell.max_noise_db,
      })),
    },
    network_analysis: {
      ...graph.stats,
      max_corridor_usage_count: Math.max(
        0,
        ...scoredSegments.features.map((feature) => feature.properties.corridor_usage_count ?? 0),
      ),
      component_summaries: componentSummaries.map((summary) => ({
        component_id: summary.component_id,
        label: summary.label,
        node_count: summary.node_count,
        edge_count: summary.edge_count,
        total_edge_length_km: summary.total_edge_length_km,
        demand_weight: summary.demand_weight,
        demand_point_count: summary.demand_point_count,
        rack_count: summary.rack_count,
        infrastructure_count: summary.infrastructure_count,
        center: summary.center,
        bounds: summary.bounds,
      })),
    },
    corridor_recommendations: {
      scenario: CORRIDOR_SCENARIO,
      hotspots: corridorAnalysis.hotspots,
      recommended: corridorAnalysis.corridors.map((corridor) => ({
        corridor_id: corridor.corridor_id,
        corridor_rank: corridor.corridor_rank,
        label: corridor.label,
        from_hub_id: corridor.from_hub_id,
        to_hub_id: corridor.to_hub_id,
        from_label: corridor.from_label,
        to_label: corridor.to_label,
        from_h3_index: corridor.from_h3_index,
        to_h3_index: corridor.to_h3_index,
        direct_distance_km: corridor.direct_distance_km,
        path_length_km: corridor.path_length_km,
        path_cost: corridor.path_cost,
        pair_priority: corridor.pair_priority,
        segment_count: corridor.segment_count,
        mean_segment_score: corridor.mean_segment_score,
        min_segment_score: corridor.min_segment_score,
        mean_h3_score: corridor.mean_h3_score,
        min_h3_score: corridor.min_h3_score,
        max_noise_db: corridor.max_noise_db,
        mean_greenery_ratio: corridor.mean_greenery_ratio,
        mean_rack_distance_m: corridor.mean_rack_distance_m,
        mean_infrastructure_distance_m: corridor.mean_infrastructure_distance_m,
        center: corridor.center,
        bounds: corridor.bounds,
      })),
    },
    off_network_connectors: {
      scenario: CONNECTOR_SCENARIO,
      recommended: connectorAnalysis.connectors.map((connector) => ({
        connector_id: connector.connector_id,
        connector_rank: connector.connector_rank,
        label: connector.label,
        source_component_id: connector.source_component_id,
        target_component_id: connector.target_component_id,
        source_component_label: connector.source_component_label,
        target_component_label: connector.target_component_label,
        source_node_id: connector.source_node_id,
        target_node_id: connector.target_node_id,
        length_m: connector.length_m,
        length_km: connector.length_km,
        demand_gain_points: connector.demand_gain_points,
        network_gain_points: connector.network_gain_points,
        distance_points: connector.distance_points,
        environment_points: connector.environment_points,
        crossing_penalty_points: connector.crossing_penalty_points,
        priority_score: connector.priority_score,
        greenery_ratio: connector.greenery_ratio,
        max_noise_db: connector.max_noise_db,
        noise_score: connector.noise_score,
        network_crossings_count: connector.network_crossings_count,
        source_component_demand_weight: connector.source_component_demand_weight,
        target_component_demand_weight: connector.target_component_demand_weight,
        target_component_nodes: connector.target_component_nodes,
        target_component_edges: connector.target_component_edges,
        center: connector.center,
        bounds: connector.bounds,
      })),
    },
    explainability: {
      data_sources: DATA_SOURCES,
      processing_steps: PROCESSING_STEPS,
      map_layers: MAP_LAYER_ORDER,
      scoring: {
        version: 'v2_linear_weighted',
        sample_step_meters: SAMPLE_STEP_METERS,
        output_range: [0, 100],
        tie_breakers: ['score desc', 'length desc', 'segment_id asc'],
        weights: SCORE_WEIGHTS,
        references: SCORE_REFERENCES,
        formula:
          'score = greenery_score*0.35 + noise_score*0.30 + rack_score*0.20 + infrastructure_score*0.15',
      },
      h3_indexing: {
        scenario: H3_SCENARIO,
      },
      corridor_optimization: {
        scenario: CORRIDOR_SCENARIO,
        graph_snap_decimals: GRAPH_SNAP_DECIMALS,
      },
      connector_optimization: {
        scenario: CONNECTOR_SCENARIO,
        endpoint_proximity_tolerance_meters: CONNECTOR_ENDPOINT_PROXIMITY_TOLERANCE_METERS,
      },
      limitations: METHOD_LIMITATIONS,
      nondeterminism: NONDETERMINISM,
    },
    top_score_threshold: topSegments[topSegments.length - 1]?.score ?? 0,
    top_segments: topSegments,
  }
}

function computeScoreBreakdown({
  greeneryRatio,
  maxNoiseDb,
  nearestRackDistanceM,
  nearestInfraDistanceM,
}) {
  const greeneryScore = clamp(greeneryRatio * 100, 0, 100)
  const noiseScore =
    maxNoiseDb == null
      ? SCORE_REFERENCES.noiseDb.missingScore
      : scaleDescending(maxNoiseDb, SCORE_REFERENCES.noiseDb.best, SCORE_REFERENCES.noiseDb.worst)
  const rackScore =
    nearestRackDistanceM == null
      ? SCORE_REFERENCES.rackDistanceM.missingScore
      : scaleDescending(
          nearestRackDistanceM,
          SCORE_REFERENCES.rackDistanceM.best,
          SCORE_REFERENCES.rackDistanceM.worst,
        )
  const infrastructureScore =
    nearestInfraDistanceM == null
      ? SCORE_REFERENCES.infrastructureDistanceM.missingScore
      : scaleDescending(
          nearestInfraDistanceM,
          SCORE_REFERENCES.infrastructureDistanceM.best,
          SCORE_REFERENCES.infrastructureDistanceM.worst,
        )

  const greeneryPoints = greeneryScore * SCORE_WEIGHTS.greenery
  const noisePoints = noiseScore * SCORE_WEIGHTS.noise
  const rackPoints = rackScore * SCORE_WEIGHTS.rack
  const infrastructurePoints = infrastructureScore * SCORE_WEIGHTS.infrastructure

  return {
    greenery: {
      score: greeneryScore,
      points: greeneryPoints,
    },
    noise: {
      score: noiseScore,
      points: noisePoints,
    },
    rack: {
      score: rackScore,
      points: rackPoints,
    },
    infrastructure: {
      score: infrastructureScore,
      points: infrastructurePoints,
    },
    total: clamp(greeneryPoints + noisePoints + rackPoints + infrastructurePoints, 0, 100),
  }
}

function compareSegmentRank(left, right) {
  const scoreDelta = (right.properties.score ?? 0) - (left.properties.score ?? 0)
  if (scoreDelta !== 0) {
    return scoreDelta
  }

  const lengthDelta = (right.properties.length_km ?? 0) - (left.properties.length_km ?? 0)
  if (lengthDelta !== 0) {
    return lengthDelta
  }

  return (left.properties.segment_id ?? 0) - (right.properties.segment_id ?? 0)
}

function buildCorridorSamples(lineFeature, lengthKm) {
  const steps =
    lengthKm > 0 ? Math.max(1, Math.ceil((lengthKm * 1000) / SAMPLE_STEP_METERS)) : 1

  return Array.from({ length: steps + 1 }, (_, index) => {
    const distanceKm = lengthKm === 0 ? 0 : (lengthKm * index) / steps
    const point = safeAlong(lineFeature, distanceKm)

    if (!point) {
      return null
    }

    const coordinates = point.geometry?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null
    }

    return {
      point,
      searchItem: {
        minX: coordinates[0],
        minY: coordinates[1],
        maxX: coordinates[0],
        maxY: coordinates[1],
      },
    }
  }).filter(Boolean)
}

function computeGreeneryRatio(samples, greeneryIndex, greeneryFeatures) {
  if (samples.length === 0) {
    return 0
  }

  let greeneryHits = 0

  for (const sample of samples) {
    const candidates = greeneryIndex
      .search(sample.searchItem)
      .map((item) => greeneryFeatures[item.featureIndex])

    const intersectsGreenery = candidates.some((polygon) =>
      safeBooleanPointInPolygon(sample.point, polygon),
    )

    if (intersectsGreenery) {
      greeneryHits += 1
    }
  }

  return clamp(greeneryHits / samples.length, 0, 1)
}

function computeMaxNoise(samples, noiseIndex, noiseFeatures) {
  let maxNoise = null

  for (const sample of samples) {
    const candidates = noiseIndex
      .search(sample.searchItem)
      .map((item) => noiseFeatures[item.featureIndex])

    for (const polygon of candidates) {
      if (!safeBooleanPointInPolygon(sample.point, polygon)) {
        continue
      }

      const candidate = extractNoiseValue(polygon.properties)
      if (candidate == null) {
        continue
      }

      if (maxNoise == null || candidate > maxNoise) {
        maxNoise = candidate
      }
    }
  }

  return maxNoise
}

function findNearestPointDistanceToLine(pointFeatures, pointIndex, lineFeature) {
  const bounds = safeBbox(lineFeature)
  if (!bounds) {
    return null
  }

  let minDistance = null
  let searchMeters = 150

  while (searchMeters <= 5000) {
    const candidates = pointIndex
      .search(expandSearchItem(bounds, searchMeters))
      .map((item) => pointFeatures[item.featureIndex])

    if (candidates.length === 0) {
      searchMeters *= 2
      continue
    }

    minDistance = computeMinPointDistance(candidates, lineFeature, minDistance)

    if (minDistance != null && searchMeters >= minDistance) {
      return minDistance
    }

    searchMeters *= 2
  }

  return computeMinPointDistance(pointFeatures, lineFeature, minDistance)
}

function computeMinPointDistance(pointFeatures, lineFeature, seedDistance = null) {
  let minDistance = seedDistance

  for (const pointFeature of pointFeatures) {
    try {
      const distance = turf.pointToLineDistance(pointFeature, lineFeature, {
        units: 'meters',
      })

      if (!Number.isFinite(distance)) {
        continue
      }

      if (minDistance == null || distance < minDistance) {
        minDistance = distance
      }
    } catch {
      continue
    }
  }

  return minDistance
}

function mapPointFeatures(featureCollection, pointKind) {
  return {
    type: 'FeatureCollection',
    features: featureCollection.features.map((feature, index) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        point_id: index + 1,
        point_kind: pointKind,
        type: cleanText(feature.properties?.typ) ?? null,
        name: cleanText(feature.properties?.nazwa) ?? cleanText(feature.properties?.adres) ?? null,
        status: cleanText(feature.properties?.status) ?? cleanText(feature.properties?.stan) ?? null,
        count: toFiniteNumber(feature.properties?.liczba),
        description: cleanText(feature.properties?.opis) ?? null,
      },
    })),
  }
}

function mapCyclingPathFeatures(featureCollection) {
  return {
    type: 'FeatureCollection',
    features: featureCollection.features.map((feature) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        kind: cleanText(feature.properties?.rodzaj) ?? null,
        surface: cleanText(feature.properties?.nawierzchn) ?? null,
      },
    })),
  }
}

function mapGreeneryFeatures(featureCollection) {
  return {
    type: 'FeatureCollection',
    features: featureCollection.features.map((feature) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        greenery_category: cleanText(feature.properties?.greenery_category) ?? null,
        kind: cleanText(feature.properties?.RODZAJ) ?? null,
      },
    })),
  }
}

function mapNoiseFeatures(featureCollection) {
  return {
    type: 'FeatureCollection',
    features: featureCollection.features.map((feature) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        noise_source: cleanText(feature.properties?.noise_source) ?? null,
        isov1: toFiniteNumber(feature.properties?.isov1),
        isov2: toFiniteNumber(feature.properties?.isov2),
      },
    })),
  }
}

async function loadShapefileFromZip(zip, stem) {
  const shpBuffer = readZipEntry(zip, `${stem}.shp`)
  const dbfBuffer = readZipEntry(zip, `${stem}.dbf`)
  const prjBuffer = readZipEntry(zip, `${stem}.prj`)
  const cpgBuffer = readZipEntry(zip, `${stem}.cpg`)

  if (!shpBuffer || !dbfBuffer) {
    throw new Error(`Missing shapefile bundle for ${stem}`)
  }

  const parsed = await shp({
    shp: shpBuffer,
    dbf: dbfBuffer,
    prj: prjBuffer,
    cpg: cpgBuffer,
  })

  return toFeatureCollection(parsed)
}

function readZipGeoJson(zip, entryName) {
  return JSON.parse(stripBom(readZipEntry(zip, entryName)?.toString('utf8') ?? ''))
}

function readZipEntry(zip, entryName) {
  const entry = zip.getEntry(entryName)
  if (!entry) {
    throw new Error(`Missing zip entry: ${entryName}`)
  }

  return entry.getData()
}

function flattenByGeometry(featureCollection, allowedTypes) {
  const flattened = turf.flatten(toFeatureCollection(featureCollection))

  return {
    type: 'FeatureCollection',
    features: flattened.features
      .filter((feature) => allowedTypes.includes(feature?.geometry?.type))
      .map((feature) => ({
        type: 'Feature',
        geometry: normalizeGeometry(feature.geometry),
        properties: feature.properties ?? {},
      }))
      .filter((feature) => feature.geometry != null),
  }
}

function mergeFeatureCollections(collections) {
  return {
    type: 'FeatureCollection',
    features: collections.flatMap((collection) => toFeatureCollection(collection).features),
  }
}

function tagFeatures(featureCollection, extraProperties) {
  const fc = toFeatureCollection(featureCollection)

  return {
    type: 'FeatureCollection',
    features: fc.features.map((feature) => ({
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        ...extraProperties,
      },
    })),
  }
}

function toFeatureCollection(input) {
  if (!input) {
    return { type: 'FeatureCollection', features: [] }
  }

  if (Array.isArray(input)) {
    return {
      type: 'FeatureCollection',
      features: input.flatMap((item) => toFeatureCollection(item).features),
    }
  }

  if (input.type === 'FeatureCollection') {
    return input
  }

  if (input.type === 'Feature') {
    return {
      type: 'FeatureCollection',
      features: [input],
    }
  }

  throw new Error('Unsupported GeoJSON structure.')
}

function reprojectFeatureCollection(featureCollection, fromCrs, toCrs) {
  const fc = toFeatureCollection(featureCollection)

  return {
    type: 'FeatureCollection',
    features: fc.features.map((feature) => reprojectFeature(feature, fromCrs, toCrs)),
  }
}

function reprojectFeature(feature, fromCrs, toCrs) {
  if (!feature?.geometry) {
    return feature
  }

  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: reprojectCoordinates(feature.geometry.coordinates, fromCrs, toCrs),
    },
  }
}

function reprojectCoordinates(coordinates, fromCrs, toCrs) {
  if (!Array.isArray(coordinates)) {
    return coordinates
  }

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    const [x, y] = proj4(fromCrs, toCrs, [coordinates[0], coordinates[1]])
    return [x, y]
  }

  return coordinates.map((item) => reprojectCoordinates(item, fromCrs, toCrs))
}

function normalizeGeometry(geometry) {
  if (!geometry?.coordinates) {
    return null
  }

  return {
    ...geometry,
    coordinates: normalizeCoordinates(geometry.coordinates),
  }
}

function normalizeCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) {
    return coordinates
  }

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === 'number' &&
    typeof coordinates[1] === 'number'
  ) {
    return [coordinates[0], coordinates[1]]
  }

  return coordinates.map((item) => normalizeCoordinates(item))
}

function buildFeatureIndex(features) {
  const tree = new RBush()

  features.forEach((feature, featureIndex) => {
    const bounds = safeBbox(feature)
    const item = bboxToSearchItem(bounds)
    if (!item) {
      return
    }

    tree.insert({
      ...item,
      featureIndex,
    })
  })

  return tree
}

function bboxToSearchItem(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    return null
  }

  return {
    minX: bounds[0],
    minY: bounds[1],
    maxX: bounds[2],
    maxY: bounds[3],
  }
}

function expandSearchItem(bounds, meters) {
  const latitude = ((bounds[1] + bounds[3]) / 2) * (Math.PI / 180)
  const latDelta = meters / 111320
  const lonDelta = meters / (111320 * Math.max(Math.cos(latitude), 0.2))

  return {
    minX: bounds[0] - lonDelta,
    minY: bounds[1] - latDelta,
    maxX: bounds[2] + lonDelta,
    maxY: bounds[3] + latDelta,
  }
}

function extractNoiseValue(properties) {
  const candidates = [properties?.isov2, properties?.isov1]

  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate)
    if (value != null) {
      return value
    }
  }

  return null
}

function scaleDescending(value, best, worst) {
  if (!Number.isFinite(value)) {
    return 0
  }

  if (worst <= best) {
    return value <= best ? 100 : 0
  }

  return clamp(((worst - value) / (worst - best)) * 100, 0, 100)
}

function isCoordinate(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

function projectCoordinate(coordinate, referenceLatitude) {
  const metersPerLatDegree = 111320
  const metersPerLonDegree = 111320 * Math.max(Math.cos((referenceLatitude * Math.PI) / 180), 0.2)

  return {
    x: coordinate[0] * metersPerLonDegree,
    y: coordinate[1] * metersPerLatDegree,
  }
}

function unprojectCoordinate(point, referenceLatitude) {
  const metersPerLatDegree = 111320
  const metersPerLonDegree = 111320 * Math.max(Math.cos((referenceLatitude * Math.PI) / 180), 0.2)

  return [round(point.x / metersPerLonDegree, 6), round(point.y / metersPerLatDegree, 6)]
}

function coordinateDistanceMeters(left, right) {
  const referenceLatitude = (left[1] + right[1]) / 2
  const leftPoint = projectCoordinate(left, referenceLatitude)
  const rightPoint = projectCoordinate(right, referenceLatitude)
  const deltaX = leftPoint.x - rightPoint.x
  const deltaY = leftPoint.y - rightPoint.y

  return Math.sqrt(deltaX * deltaX + deltaY * deltaY)
}

function approximateBoundsAreaSqMeters(bounds) {
  const referenceLatitude = (bounds[1] + bounds[3]) / 2
  const southWest = projectCoordinate([bounds[0], bounds[1]], referenceLatitude)
  const northEast = projectCoordinate([bounds[2], bounds[3]], referenceLatitude)

  return Math.abs((northEast.x - southWest.x) * (northEast.y - southWest.y))
}

function coordinatesBounds(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return null
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  coordinates.forEach((coordinate) => {
    if (!isCoordinate(coordinate)) {
      return
    }

    minX = Math.min(minX, coordinate[0])
    minY = Math.min(minY, coordinate[1])
    maxX = Math.max(maxX, coordinate[0])
    maxY = Math.max(maxY, coordinate[1])
  })

  if (![minX, minY, maxX, maxY].every((value) => Number.isFinite(value))) {
    return null
  }

  return [round(minX, 6), round(minY, 6), round(maxX, 6), round(maxY, 6)]
}

function safeLength(feature) {
  try {
    return turf.length(feature, { units: 'kilometers' })
  } catch {
    return 0
  }
}

function safeBooleanPointInPolygon(point, polygon) {
  try {
    return turf.booleanPointInPolygon(point, polygon)
  } catch {
    return false
  }
}

function safeAlong(feature, distanceKm) {
  try {
    return turf.along(feature, distanceKm, { units: 'kilometers' })
  } catch {
    return null
  }
}

function safeBbox(feature) {
  try {
    return turf.bbox(feature)
  } catch {
    return null
  }
}

function safeLineIntersections(left, right) {
  try {
    return turf.lineIntersect(left, right).features
  } catch {
    return []
  }
}

function safePointOnFeature(feature) {
  try {
    const point = turf.pointOnFeature(feature)
    return normalizeCoordinates(point.geometry.coordinates)
  } catch {
    const bounds = safeBbox(feature)
    if (!bounds) {
      return null
    }

    return [
      round((bounds[0] + bounds[2]) / 2, 6),
      round((bounds[1] + bounds[3]) / 2, 6),
    ]
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

async function ensureFileExists(filePath) {
  await fs.access(filePath)
}

function stripBom(value) {
  if (!value) {
    return value
  }

  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function cleanText(value) {
  if (typeof value !== 'string') {
    return value ?? null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function toFiniteNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

function mean(values) {
  if (values.length === 0) {
    return 0
  }

  return values.reduce((total, value) => total + value, 0) / values.length
}

function median(values) {
  if (values.length === 0) {
    return 0
  }

  const middle = Math.floor(values.length / 2)
  if (values.length % 2 === 0) {
    return (values[middle - 1] + values[middle]) / 2
  }

  return values[middle]
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function roundNullable(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) {
    return null
  }

  return round(value, digits)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeScore(value, maxValue) {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
    return 0
  }

  return clamp((value / maxValue) * 100, 0, 100)
}

class MinHeap {
  constructor() {
    this.items = []
  }

  push(value) {
    this.items.push(value)
    this.bubbleUp(this.items.length - 1)
  }

  pop() {
    if (this.items.length === 0) {
      return null
    }

    const first = this.items[0]
    const last = this.items.pop()

    if (this.items.length > 0 && last) {
      this.items[0] = last
      this.bubbleDown(0)
    }

    return first
  }

  isEmpty() {
    return this.items.length === 0
  }

  bubbleUp(index) {
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

  bubbleDown(index) {
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
