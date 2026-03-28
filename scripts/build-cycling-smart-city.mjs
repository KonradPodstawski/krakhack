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
    id: 'segments-top-casing',
    role: 'top segment outline',
    data_source: 'segments.geojson',
  },
  {
    order: 4,
    id: 'segments-top-fill',
    role: 'top segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 5,
    id: 'segments-selected',
    role: 'selected segment highlight',
    data_source: 'segments.geojson',
  },
  {
    order: 6,
    id: 'points-racks',
    role: 'bike racks',
    data_source: 'points.geojson',
  },
  {
    order: 7,
    id: 'points-infrastructure',
    role: 'bike infrastructure points',
    data_source: 'points.geojson',
  },
])
const METHOD_LIMITATIONS = Object.freeze([
  'Zielen i halas sa oceniane przez probkowanie linii co staly krok, a nie przez pelne przeciecie bufora powierzchniowego.',
  'Podklad OSM sluzy tylko do orientacji przestrzennej i nie wchodzi do score.',
  'Brak warstwy ruchu drogowego, nachylenia i bezpieczenstwa skrzyzowan, wiec ranking nie jest pelna ocena jakosci trasy.',
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
  const pointsLayer = buildPointsLayer(datasets)
  const summary = buildSummary(datasets, scoredSegments)

  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  await Promise.all([
    writeJson(path.join(OUTPUT_DIR, 'segments.geojson'), scoredSegments),
    writeJson(path.join(OUTPUT_DIR, 'points.geojson'), pointsLayer),
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

function buildSummary(datasets, scoredSegments) {
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
