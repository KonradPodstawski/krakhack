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
    const comfortScore = computeComfortScore({
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
        comfort_score: round(comfortScore, 2),
        score: round(comfortScore, 2),
        center,
        is_top_segment: false,
        score_rank: null,
      },
    })
  }

  const ranked = [...features]
    .sort((left, right) => {
      const scoreDelta = (right.properties.score ?? 0) - (left.properties.score ?? 0)
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      return (left.properties.segment_id ?? 0) - (right.properties.segment_id ?? 0)
    })
    .slice(0, TOP_SEGMENT_COUNT)

  ranked.forEach((feature, rank) => {
    feature.properties.is_top_segment = true
    feature.properties.score_rank = rank + 1
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
    top_score_threshold: topSegments[topSegments.length - 1]?.score ?? 0,
    top_segments: topSegments,
  }
}

function computeComfortScore({
  greeneryRatio,
  maxNoiseDb,
  nearestRackDistanceM,
  nearestInfraDistanceM,
}) {
  const greeneryBonus = greeneryRatio * 45
  const noisePenalty =
    maxNoiseDb == null ? 0 : Math.max(0, (Number(maxNoiseDb) - 45) * 1.2)
  const rackPenalty =
    nearestRackDistanceM == null ? 10 : Math.min(nearestRackDistanceM / 40, 25)
  const infraPenalty =
    nearestInfraDistanceM == null ? 8 : Math.min(nearestInfraDistanceM / 80, 15)

  return clamp(100 - noisePenalty - rackPenalty - infraPenalty + greeneryBonus, 0, 100)
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
