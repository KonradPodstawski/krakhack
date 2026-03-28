import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import shp from 'shpjs'
import proj4 from 'proj4'
import * as turf from '@turf/turf'
import RBush from 'rbush'

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
const HOTSPOT_GRID_METERS = 1200
const HOTSPOT_BANDWIDTH_METERS = 900
const HOTSPOT_COUNT = 6
const HOTSPOT_MIN_DISTANCE_METERS = 1400
const HOTSPOT_MAX_NODE_DISTANCE_METERS = 700
const MIN_CORRIDOR_DISTANCE_METERS = 2000
const RECOMMENDED_CORRIDOR_COUNT = 5
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
const CORRIDOR_SCENARIO = Object.freeze({
  id: 'balanced_corridor_v1',
  label: 'Balanced corridor priority',
  hotspot_grid_meters: HOTSPOT_GRID_METERS,
  hotspot_bandwidth_meters: HOTSPOT_BANDWIDTH_METERS,
  hotspot_count: HOTSPOT_COUNT,
  min_hotspot_separation_meters: HOTSPOT_MIN_DISTANCE_METERS,
  max_hub_snap_distance_meters: HOTSPOT_MAX_NODE_DISTANCE_METERS,
  min_pair_distance_meters: MIN_CORRIDOR_DISTANCE_METERS,
  recommended_corridor_count: RECOMMENDED_CORRIDOR_COUNT,
  edge_cost_formula: 'edge_cost = length_m * (1 + (100 - segment_score) / 100)',
  pair_priority_formula:
    'pair_priority = (from_density_score + to_density_score) * direct_distance_km',
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
    id: 'segments-base',
    role: 'all scored segments',
    data_source: 'segments.geojson',
  },
  {
    order: 3,
    id: 'corridors-base',
    role: 'recommended corridor outline',
    data_source: 'corridors.geojson',
  },
  {
    order: 4,
    id: 'corridors-fill',
    role: 'recommended corridor highlight',
    data_source: 'corridors.geojson',
  },
  {
    order: 5,
    id: 'corridors-selected',
    role: 'selected corridor highlight',
    data_source: 'corridors.geojson',
  },
  {
    order: 6,
    id: 'segments-top-casing',
    role: 'top segment outline',
    data_source: 'segments.geojson',
  },
  {
    order: 7,
    id: 'segments-top-fill',
    role: 'top segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 8,
    id: 'segments-selected',
    role: 'selected segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 9,
    id: 'hotspots',
    role: 'demand hotspots',
    data_source: 'hotspots.geojson',
  },
  {
    order: 10,
    id: 'points-racks',
    role: 'bike racks',
    data_source: 'points.geojson',
  },
  {
    order: 11,
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
  'Hotspoty popytu sa estymowane z punktow infrastruktury i stojakow, a nie z danych demograficznych ani ruchowych.',
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
  const graph = buildCyclingGraph(scoredSegments)
  const demandHotspots = buildDemandHotspots(datasets, graph, safeBbox(scoredSegments))
  const corridorAnalysis = buildCorridorRecommendations(scoredSegments, graph, demandHotspots)
  applyCorridorUsage(scoredSegments, corridorAnalysis.segmentUsageBySegmentId)
  const pointsLayer = buildPointsLayer(datasets)
  const hotspotsLayer = buildHotspotsLayer(corridorAnalysis.hotspots)
  const corridorsLayer = buildCorridorsLayer(corridorAnalysis.corridors)
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
    corridorAnalysis,
  )

  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  await Promise.all([
    writeJson(path.join(OUTPUT_DIR, 'segments.geojson'), scoredSegments),
    writeJson(path.join(OUTPUT_DIR, 'points.geojson'), pointsLayer),
    writeJson(path.join(OUTPUT_DIR, 'hotspots.geojson'), hotspotsLayer),
    writeJson(path.join(OUTPUT_DIR, 'corridors.geojson'), corridorsLayer),
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
        center: hotspot.center,
        density_score: hotspot.density_score,
        total_weight: hotspot.total_weight,
        point_count: hotspot.point_count,
        rack_count: hotspot.rack_count,
        infrastructure_count: hotspot.infrastructure_count,
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
        direct_distance_km: corridor.direct_distance_km,
        path_length_km: corridor.path_length_km,
        path_cost: corridor.path_cost,
        pair_priority: corridor.pair_priority,
        segment_count: corridor.segment_count,
        mean_segment_score: corridor.mean_segment_score,
        min_segment_score: corridor.min_segment_score,
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

function buildCyclingGraph(scoredSegments) {
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

    edges.push({
      edge_id: edges.length + 1,
      segment_id: feature.properties.segment_id,
      start_node_id: startNode.node_id,
      end_node_id: endNode.node_id,
      coordinates,
      length_m: round(lengthM, 2),
      edge_cost: round(computeEdgeTravelCost(lengthM, feature.properties.score), 4),
      segment_score: round(Number(feature.properties.score ?? 0), 2),
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

function buildDemandHotspots(datasets, graph, bounds) {
  if (!bounds) {
    return []
  }

  const demandPoints = extractDemandPoints(datasets)
  if (demandPoints.length === 0) {
    return []
  }

  const referenceLatitude = (bounds[1] + bounds[3]) / 2
  const minProjected = projectCoordinate([bounds[0], bounds[1]], referenceLatitude)
  const cellMap = new Map()

  for (const point of demandPoints) {
    const projected = projectCoordinate(point.coordinate, referenceLatitude)
    const cellX = Math.floor((projected.x - minProjected.x) / HOTSPOT_GRID_METERS)
    const cellY = Math.floor((projected.y - minProjected.y) / HOTSPOT_GRID_METERS)
    const cellId = `${cellX}:${cellY}`
    const cell = cellMap.get(cellId) ?? {
      cell_id: cellId,
      cell_x: cellX,
      cell_y: cellY,
      rack_count: 0,
      infrastructure_count: 0,
      point_count: 0,
      total_weight: 0,
    }

    cell.point_count += 1
    cell.total_weight += point.weight

    if (point.point_kind === 'rack') {
      cell.rack_count += 1
    } else {
      cell.infrastructure_count += 1
    }

    cellMap.set(cellId, cell)
  }

  const cells = [...cellMap.values()].map((cell) => {
    const center = unprojectCoordinate(
      {
        x: minProjected.x + (cell.cell_x + 0.5) * HOTSPOT_GRID_METERS,
        y: minProjected.y + (cell.cell_y + 0.5) * HOTSPOT_GRID_METERS,
      },
      referenceLatitude,
    )

    const densityScore = computeGaussianDensityScore(center, demandPoints, HOTSPOT_BANDWIDTH_METERS)

    return {
      ...cell,
      center,
      density_score: round(densityScore, 3),
    }
  })

  cells.sort((left, right) => {
    const densityDelta = right.density_score - left.density_score
    if (densityDelta !== 0) {
      return densityDelta
    }

    const weightDelta = right.total_weight - left.total_weight
    if (weightDelta !== 0) {
      return weightDelta
    }

    return left.cell_id.localeCompare(right.cell_id)
  })

  const hotspotCandidates = []

  for (const cell of cells) {
    const snappedNode = findNearestNode(
      cell.center,
      graph.node_index,
      graph.nodes,
      HOTSPOT_MAX_NODE_DISTANCE_METERS,
    )

    if (!snappedNode) {
      continue
    }

    hotspotCandidates.push({
      center: cell.center,
      density_score: round(cell.density_score, 3),
      total_weight: round(cell.total_weight, 2),
      point_count: cell.point_count,
      rack_count: cell.rack_count,
      infrastructure_count: cell.infrastructure_count,
      graph_node_id: snappedNode.node_id,
      snap_distance_m: round(snappedNode.distance_m, 2),
      cell_id: cell.cell_id,
      component_id: graph.node_component_id_by_node_id[snappedNode.node_id] ?? null,
    })
  }

  const largestComponentCandidates = hotspotCandidates.filter(
    (candidate) => candidate.component_id === graph.largest_component_id,
  )
  const selectionPool =
    largestComponentCandidates.length >= 2 ? largestComponentCandidates : hotspotCandidates
  const hotspots = []

  for (const candidate of selectionPool) {
    const tooClose = hotspots.some(
      (existing) =>
        coordinateDistanceMeters(existing.center, candidate.center) < HOTSPOT_MIN_DISTANCE_METERS,
    )

    if (tooClose) {
      continue
    }

    hotspots.push({
      ...candidate,
      hub_id: hotspots.length + 1,
      label: `Hub ${hotspots.length + 1}`,
    })

    if (hotspots.length >= HOTSPOT_COUNT) {
      break
    }
  }

  return hotspots
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
        pair_priority:
          (fromHub.density_score + toHub.density_score) * (directDistanceMeters / 1000),
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
    direct_distance_km: round(candidate.direct_distance_km, 2),
    path_length_km: round(pathLengthKm, 2),
    path_cost: round(path.total_cost, 2),
    pair_priority: round(candidate.pair_priority, 2),
    segment_count: traversedEdges.length,
    mean_segment_score: round(mean(scores), 2),
    min_segment_score: round(scores.length === 0 ? 0 : Math.min(...scores), 2),
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

function buildSummary(datasets, scoredSegments, graph, spatialStatistics, corridorAnalysis) {
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
    network_analysis: {
      ...graph.stats,
      max_corridor_usage_count: Math.max(
        0,
        ...scoredSegments.features.map((feature) => feature.properties.corridor_usage_count ?? 0),
      ),
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
        direct_distance_km: corridor.direct_distance_km,
        path_length_km: corridor.path_length_km,
        path_cost: corridor.path_cost,
        pair_priority: corridor.pair_priority,
        segment_count: corridor.segment_count,
        mean_segment_score: corridor.mean_segment_score,
        min_segment_score: corridor.min_segment_score,
        max_noise_db: corridor.max_noise_db,
        mean_greenery_ratio: corridor.mean_greenery_ratio,
        mean_rack_distance_m: corridor.mean_rack_distance_m,
        mean_infrastructure_distance_m: corridor.mean_infrastructure_distance_m,
        center: corridor.center,
        bounds: corridor.bounds,
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
      corridor_optimization: {
        scenario: CORRIDOR_SCENARIO,
        graph_snap_decimals: GRAPH_SNAP_DECIMALS,
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
