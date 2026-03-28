<script lang="ts">
  import { afterUpdate, onDestroy, onMount } from 'svelte'
  import type { Map as MapLibreMap, MapGeoJSONFeature, Popup as MapLibrePopup } from 'maplibre-gl'
  import {
    KRAKOW_CENTER,
    MAP_STYLE,
    formatCount,
    formatDistance,
    formatKilometers,
    formatNoise,
    formatPoints,
    formatPercent,
    formatScore,
    scoreColor,
    type H3CellSummary,
    type HotspotSummary,
    type RecommendedConnector,
    type RecommendedCorridor,
    type Summary,
    type TopSegment,
  } from './lib/smart-city'

  const SUMMARY_URL = '/generated/cycling-smart-city/summary.json'
  const SEGMENTS_URL = '/generated/cycling-smart-city/segments.geojson'
  const POINTS_URL = '/generated/cycling-smart-city/points.geojson'
  const HEXES_URL = '/generated/cycling-smart-city/hexes.geojson'
  const HOTSPOTS_URL = '/generated/cycling-smart-city/hotspots.geojson'
  const CORRIDORS_URL = '/generated/cycling-smart-city/corridors.geojson'
  const CONNECTORS_URL = '/generated/cycling-smart-city/connectors.geojson'

  let mapContainer: HTMLDivElement
  let maplibreModule: typeof import('maplibre-gl') | null = null
  let map: MapLibreMap | null = null
  let popup: MapLibrePopup | null = null

  let summary: Summary | null = null
  let selectedSegment: TopSegment | null = null
  let selectedCorridor: RecommendedCorridor | null = null
  let selectedConnector: RecommendedConnector | null = null
  let selectedHex: H3CellSummary | null = null
  let error: string | null = null
  let isLoading = true
  let isMapReady = false

  let showHexes = true
  let showRacks = true
  let showInfrastructure = true
  let showHotspots = true
  let showCorridors = true
  let showConnectors = true
  let onlyTopSegments = false

  const scoreLegend = [
    { label: '80-100', color: '#166534' },
    { label: '65-79', color: '#65a30d' },
    { label: '50-64', color: '#d97706' },
    { label: '0-49', color: '#b91c1c' },
  ]

  const scoreComponentMeta = {
    greenery: {
      label: 'Zielen',
      note: 'Procent probek segmentu, ktore wpadaja w poligony zieleni.',
    },
    noise: {
      label: 'Halas',
      note: 'Im mniejszy halas, tym wyzszy subscore.',
    },
    rack: {
      label: 'Stojaki',
      note: 'Im blizej stojaka, tym wyzszy subscore.',
    },
    infrastructure: {
      label: 'Infrastruktura',
      note: 'Im blizej punktowej infrastruktury, tym wyzszy subscore.',
    },
  } as const

  onMount(() => {
    void initialize()
  })

  onDestroy(() => {
    isMapReady = false
    popup?.remove()
    popup = null
    map?.remove()
    map = null
  })

  afterUpdate(() => {
    syncHexVisibility()
    syncPointVisibility()
    syncHotspotVisibility()
    syncCorridorVisibility()
    syncConnectorVisibility()
    syncSegmentFilter()
    syncSelectedSegment()
    syncSelectedCorridor()
    syncSelectedConnector()
  })

  async function initialize() {
    isLoading = true
    isMapReady = false
    error = null

    try {
      summary = await fetchJson<Summary>(SUMMARY_URL)
      selectedSegment = summary.top_segments[0] ?? null
      selectedCorridor = summary.corridor_recommendations.recommended[0] ?? null
      selectedConnector = summary.off_network_connectors.recommended[0] ?? null
      selectedHex = summary.h3_grid.top_cells[0] ?? null

      maplibreModule = await import('maplibre-gl')

      map = new maplibreModule.Map({
        container: mapContainer,
        style: MAP_STYLE,
        attributionControl: { compact: true },
      })

      map.addControl(
        new maplibreModule.NavigationControl({ visualizePitch: false }),
        'top-right',
      )

      map.on('load', () => {
        if (!map || !summary?.bounds) {
          return
        }

        addSources(map)
        addLayers(map)
        bindMapEvents(map)
        isMapReady = true
        syncHexVisibility()
        syncPointVisibility()
        syncHotspotVisibility()
        syncCorridorVisibility()
        syncConnectorVisibility()
        syncSegmentFilter()
        syncSelectedSegment()
        syncSelectedCorridor()
        syncSelectedConnector()
        resetView()

        isLoading = false
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Nie udało sie wczytac danych.'
      isLoading = false
    }
  }

  function addSources(currentMap: MapLibreMap) {
    currentMap.addSource('hexes', {
      type: 'geojson',
      data: HEXES_URL,
    })

    currentMap.addSource('segments', {
      type: 'geojson',
      data: SEGMENTS_URL,
      lineMetrics: true,
    })

    currentMap.addSource('points', {
      type: 'geojson',
      data: POINTS_URL,
    })

    currentMap.addSource('hotspots', {
      type: 'geojson',
      data: HOTSPOTS_URL,
    })

    currentMap.addSource('corridors', {
      type: 'geojson',
      data: CORRIDORS_URL,
      lineMetrics: true,
    })

    currentMap.addSource('connectors', {
      type: 'geojson',
      data: CONNECTORS_URL,
      lineMetrics: true,
    })
  }

  function addLayers(currentMap: MapLibreMap) {
    currentMap.addLayer({
      id: 'hexes-fill',
      type: 'fill',
      source: 'hexes',
      paint: {
        'fill-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'hex_score'], 0],
          0,
          '#f5f5f4',
          40,
          '#fde68a',
          60,
          '#fb923c',
          80,
          '#f97316',
          100,
          '#dc2626',
        ],
        'fill-opacity': 0.2,
        'fill-outline-color': '#a8a29e',
      },
    })

    currentMap.addLayer({
      id: 'segments-base',
      type: 'line',
      source: 'segments',
      paint: {
        'line-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'score'], 0],
          0,
          '#9f1239',
          50,
          '#c2410c',
          65,
          '#0f766e',
          80,
          '#1d4ed8',
        ],
        'line-opacity': 0.96,
        'line-width': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'score'], 0],
          0,
          2,
          100,
          5.9,
        ],
      },
    })

    currentMap.addLayer({
      id: 'corridors-base',
      type: 'line',
      source: 'corridors',
      paint: {
        'line-color': '#111827',
        'line-opacity': 0.92,
        'line-width': 10,
      },
    })

    currentMap.addLayer({
      id: 'corridors-fill',
      type: 'line',
      source: 'corridors',
      paint: {
        'line-color': '#38bdf8',
        'line-opacity': 0.96,
        'line-width': 6.5,
      },
    })

    currentMap.addLayer({
      id: 'corridors-selected',
      type: 'line',
      source: 'corridors',
      filter: ['==', ['get', 'corridor_id'], -1],
      paint: {
        'line-color': '#f97316',
        'line-opacity': 1,
        'line-width': 8.5,
      },
    })

    currentMap.addLayer({
      id: 'connectors-base',
      type: 'line',
      source: 'connectors',
      paint: {
        'line-color': '#111827',
        'line-opacity': 0.9,
        'line-width': 8,
      },
    })

    currentMap.addLayer({
      id: 'connectors-fill',
      type: 'line',
      source: 'connectors',
      paint: {
        'line-color': '#ef4444',
        'line-opacity': 0.95,
        'line-width': 4.5,
        'line-dasharray': [2, 1.2],
      },
    })

    currentMap.addLayer({
      id: 'connectors-selected',
      type: 'line',
      source: 'connectors',
      filter: ['==', ['get', 'connector_id'], -1],
      paint: {
        'line-color': '#f59e0b',
        'line-opacity': 1,
        'line-width': 6.5,
        'line-dasharray': [2, 1],
      },
    })

    currentMap.addLayer({
      id: 'segments-top-casing',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'is_top_segment'], true],
      paint: {
        'line-color': '#111827',
        'line-opacity': 0.8,
        'line-width': 9,
      },
    })

    currentMap.addLayer({
      id: 'segments-top-fill',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'is_top_segment'], true],
      paint: {
        'line-color': '#facc15',
        'line-opacity': 0.95,
        'line-width': 5.8,
      },
    })

    currentMap.addLayer({
      id: 'segments-selected',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'segment_id'], -1],
      paint: {
        'line-color': '#0ea5e9',
        'line-opacity': 1,
        'line-width': 8,
      },
    })

    currentMap.addLayer({
      id: 'points-racks',
      type: 'circle',
      source: 'points',
      filter: ['==', ['get', 'point_kind'], 'rack'],
      paint: {
        'circle-color': '#0f766e',
        'circle-radius': 5.4,
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': 1.5,
      },
    })

    currentMap.addLayer({
      id: 'points-infrastructure',
      type: 'circle',
      source: 'points',
      filter: ['==', ['get', 'point_kind'], 'infrastructure'],
      paint: {
        'circle-color': '#2563eb',
        'circle-radius': 5.9,
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': 1.5,
      },
    })

    currentMap.addLayer({
      id: 'hotspots',
      type: 'circle',
      source: 'hotspots',
      paint: {
        'circle-color': '#f97316',
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'density_score'], 0],
          0,
          6,
          15,
          12,
        ],
        'circle-opacity': 0.94,
        'circle-stroke-color': '#fff7ed',
        'circle-stroke-width': 2,
      },
    })
  }

  function bindMapEvents(currentMap: MapLibreMap) {
    for (const layerId of [
      'hexes-fill',
      'segments-base',
      'segments-top-fill',
      'points-racks',
      'points-infrastructure',
      'corridors-fill',
      'connectors-fill',
      'hotspots',
    ]) {
      currentMap.on('mouseenter', layerId, () => {
        currentMap.getCanvas().style.cursor = 'pointer'
      })
      currentMap.on('mouseleave', layerId, () => {
        currentMap.getCanvas().style.cursor = ''
      })
    }

    currentMap.on('click', 'hexes-fill', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const hex = toH3CellSummary(feature)
      selectedHex = hex
      renderPopup(event.lngLat, buildHexPopup(hex))
    })

    const handleSegmentClick = (event: {
      features?: MapGeoJSONFeature[]
      lngLat: { lat: number; lng: number }
    }) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const segment = toTopSegment(feature)
      selectedSegment = segment
      renderPopup(event.lngLat, buildSegmentPopup(segment))
    }

    currentMap.on('click', 'segments-base', handleSegmentClick)
    currentMap.on('click', 'segments-top-fill', handleSegmentClick)

    currentMap.on('click', 'corridors-fill', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const corridor = toRecommendedCorridor(feature)
      selectedCorridor = corridor
      renderPopup(event.lngLat, buildCorridorPopup(corridor))
    })

    currentMap.on('click', 'connectors-fill', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const connector = toRecommendedConnector(feature)
      selectedConnector = connector
      renderPopup(event.lngLat, buildConnectorPopup(connector))
    })

    currentMap.on('click', 'hotspots', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      renderPopup(event.lngLat, buildHotspotPopup(toHotspotSummary(feature.properties)))
    })

    currentMap.on('click', 'points-racks', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      renderPopup(event.lngLat, buildPointPopup(feature.properties))
    })

    currentMap.on('click', 'points-infrastructure', (event) => {
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      renderPopup(event.lngLat, buildPointPopup(feature.properties))
    })
  }

  function renderPopup(lngLat: { lat: number; lng: number }, html: string) {
    if (!maplibreModule) {
      return
    }

    popup?.remove()

    popup = new maplibreModule.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: '320px',
    })
      .setLngLat([lngLat.lng, lngLat.lat])
      .setHTML(html)
      .addTo(map!)
  }

  function syncPointVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('points-racks', showRacks)
    setLayerVisibility('points-infrastructure', showInfrastructure)
  }

  function syncHotspotVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('hotspots', showHotspots)
  }

  function syncHexVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('hexes-fill', showHexes)
  }

  function syncCorridorVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('corridors-base', showCorridors)
    setLayerVisibility('corridors-fill', showCorridors)
    setLayerVisibility('corridors-selected', showCorridors)
  }

  function syncConnectorVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('connectors-base', showConnectors)
    setLayerVisibility('connectors-fill', showConnectors)
    setLayerVisibility('connectors-selected', showConnectors)
  }

  function syncSegmentFilter() {
    if (!map || !isMapReady) {
      return
    }

    map.setFilter(
      'segments-base',
      onlyTopSegments ? ['==', ['get', 'is_top_segment'], true] : null,
    )
    setLayerVisibility('segments-top-casing', !onlyTopSegments)
    setLayerVisibility('segments-top-fill', !onlyTopSegments)
  }

  function syncSelectedSegment() {
    if (!map?.getLayer('segments-selected')) {
      return
    }

    map.setFilter('segments-selected', [
      '==',
      ['get', 'segment_id'],
      selectedSegment?.segment_id ?? -1,
    ])
  }

  function syncSelectedCorridor() {
    if (!map?.getLayer('corridors-selected')) {
      return
    }

    map.setFilter('corridors-selected', [
      '==',
      ['get', 'corridor_id'],
      selectedCorridor?.corridor_id ?? -1,
    ])
  }

  function syncSelectedConnector() {
    if (!map?.getLayer('connectors-selected')) {
      return
    }

    map.setFilter('connectors-selected', [
      '==',
      ['get', 'connector_id'],
      selectedConnector?.connector_id ?? -1,
    ])
  }

  function setLayerVisibility(layerId: string, visible: boolean) {
    if (!map?.getLayer(layerId)) {
      return
    }

    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  }

  function focusSegment(segment: TopSegment) {
    selectedSegment = segment

    if (!map || !segment.center) {
      return
    }

    map.easeTo({
      center: segment.center,
      zoom: 15,
      duration: 0,
    })
  }

  function focusCorridor(corridor: RecommendedCorridor) {
    selectedCorridor = corridor

    if (!map) {
      return
    }

    if (corridor.bounds) {
      map.fitBounds(
        [
          [corridor.bounds[0], corridor.bounds[1]],
          [corridor.bounds[2], corridor.bounds[3]],
        ],
        {
          padding: 72,
          duration: 0,
          maxZoom: 14.5,
        },
      )
      return
    }

    if (!corridor.center) {
      return
    }

    map.easeTo({
      center: corridor.center,
      zoom: 13.5,
      duration: 0,
    })
  }

  function focusConnector(connector: RecommendedConnector) {
    selectedConnector = connector

    if (!map) {
      return
    }

    if (connector.bounds) {
      map.fitBounds(
        [
          [connector.bounds[0], connector.bounds[1]],
          [connector.bounds[2], connector.bounds[3]],
        ],
        {
          padding: 88,
          duration: 0,
          maxZoom: 15,
        },
      )
      return
    }

    if (!connector.center) {
      return
    }

    map.easeTo({
      center: connector.center,
      zoom: 14,
      duration: 0,
    })
  }

  function focusHex(hex: H3CellSummary) {
    selectedHex = hex

    if (!map) {
      return
    }

    if (hex.bounds) {
      map.fitBounds(
        [
          [hex.bounds[0], hex.bounds[1]],
          [hex.bounds[2], hex.bounds[3]],
        ],
        {
          padding: 88,
          duration: 0,
          maxZoom: 14.5,
        },
      )
      return
    }

    map.easeTo({
      center: hex.center,
      zoom: 13.5,
      duration: 0,
    })
  }

  function resetView() {
    if (!map) {
      return
    }

    if (summary?.bounds) {
      map.fitBounds(
        [
          [summary.bounds[0], summary.bounds[1]],
          [summary.bounds[2], summary.bounds[3]],
        ],
        {
          padding: 56,
          duration: 0,
          maxZoom: 13.5,
        },
      )
      return
    }

    map.easeTo({
      center: KRAKOW_CENTER,
      zoom: 12,
      duration: 0,
    })
  }

  function toTopSegment(feature: MapGeoJSONFeature): TopSegment {
    const properties = feature.properties ?? {}

    return {
      center: parseCoordinate(properties.center),
      comfort_score: toNumber(properties.comfort_score),
      greenery_ratio: toNumber(properties.greenery_ratio),
      greenery_points: toNumber(properties.greenery_points),
      greenery_score: toNumber(properties.greenery_score),
      infrastructure_points: toNumber(properties.infrastructure_points),
      infrastructure_score: toNumber(properties.infrastructure_score),
      kind: toNullableString(properties.kind),
      length_km: toNumber(properties.length_km),
      max_noise_db: toNullableNumber(properties.max_noise_db),
      nearest_infra_m: toNullableNumber(properties.nearest_infra_m),
      nearest_rack_m: toNullableNumber(properties.nearest_rack_m),
      noise_points: toNumber(properties.noise_points),
      noise_score: toNumber(properties.noise_score),
      rack_points: toNumber(properties.rack_points),
      rack_score: toNumber(properties.rack_score),
      score: toNumber(properties.score),
      score_rank: toNullableNumber(properties.score_rank),
      segment_id: toNumber(properties.segment_id),
      surface: toNullableString(properties.surface),
    }
  }

  function toRecommendedCorridor(feature: MapGeoJSONFeature): RecommendedCorridor {
    const properties = feature.properties ?? {}

    return {
      bounds: parseBounds(properties.bounds),
      center: parseCoordinate(properties.center),
      corridor_id: toNumber(properties.corridor_id),
      corridor_rank: toNumber(properties.corridor_rank),
      direct_distance_km: toNumber(properties.direct_distance_km),
      from_h3_index: toNullableString(properties.from_h3_index) ?? 'brak',
      from_hub_id: toNumber(properties.from_hub_id),
      from_label: toNullableString(properties.from_label) ?? 'brak',
      label: toNullableString(properties.label) ?? 'brak',
      max_noise_db: toNullableNumber(properties.max_noise_db),
      mean_greenery_ratio: toNumber(properties.mean_greenery_ratio),
      mean_h3_score: toNumber(properties.mean_h3_score),
      mean_infrastructure_distance_m: toNullableNumber(properties.mean_infrastructure_distance_m),
      mean_rack_distance_m: toNullableNumber(properties.mean_rack_distance_m),
      mean_segment_score: toNumber(properties.mean_segment_score),
      min_h3_score: toNumber(properties.min_h3_score),
      min_segment_score: toNumber(properties.min_segment_score),
      pair_priority: toNumber(properties.pair_priority),
      path_cost: toNumber(properties.path_cost),
      path_length_km: toNumber(properties.path_length_km),
      segment_count: toNumber(properties.segment_count),
      to_h3_index: toNullableString(properties.to_h3_index) ?? 'brak',
      to_hub_id: toNumber(properties.to_hub_id),
      to_label: toNullableString(properties.to_label) ?? 'brak',
    }
  }

  function toRecommendedConnector(feature: MapGeoJSONFeature): RecommendedConnector {
    const properties = feature.properties ?? {}

    return {
      bounds: parseBounds(properties.bounds),
      center: parseCoordinate(properties.center),
      connector_id: toNumber(properties.connector_id),
      connector_rank: toNumber(properties.connector_rank),
      crossing_penalty_points: toNumber(properties.crossing_penalty_points),
      demand_gain_points: toNumber(properties.demand_gain_points),
      distance_points: toNumber(properties.distance_points),
      environment_points: toNumber(properties.environment_points),
      greenery_ratio: toNumber(properties.greenery_ratio),
      label: toNullableString(properties.label) ?? 'brak',
      length_km: toNumber(properties.length_km),
      length_m: toNumber(properties.length_m),
      max_noise_db: toNullableNumber(properties.max_noise_db),
      network_crossings_count: toNumber(properties.network_crossings_count),
      network_gain_points: toNumber(properties.network_gain_points),
      noise_score: toNumber(properties.noise_score),
      priority_score: toNumber(properties.priority_score),
      source_component_demand_weight: toNumber(properties.source_component_demand_weight),
      source_component_id: toNumber(properties.source_component_id),
      source_component_label: toNullableString(properties.source_component_label) ?? 'brak',
      source_node_id: toNumber(properties.source_node_id),
      target_component_demand_weight: toNumber(properties.target_component_demand_weight),
      target_component_edges: toNumber(properties.target_component_edges),
      target_component_id: toNumber(properties.target_component_id),
      target_component_label: toNullableString(properties.target_component_label) ?? 'brak',
      target_component_nodes: toNumber(properties.target_component_nodes),
      target_node_id: toNumber(properties.target_node_id),
    }
  }

  function toHotspotSummary(
    properties: Record<string, unknown> | undefined,
  ): HotspotSummary {
    return {
      center: parseCoordinate(properties?.center) ?? KRAKOW_CENTER,
      cell_id: toNullableString(properties?.cell_id) ?? 'brak',
      density_score: toNumber(properties?.density_score),
      graph_node_id: toNumber(properties?.graph_node_id),
      h3_index: toNullableString(properties?.h3_index) ?? 'brak',
      h3_resolution: toNumber(properties?.h3_resolution),
      hex_score: toNumber(properties?.hex_score),
      hub_id: toNumber(properties?.hub_id),
      infrastructure_count: toNumber(properties?.infrastructure_count),
      label: toNullableString(properties?.label) ?? 'brak',
      mean_segment_score: toNumber(properties?.mean_segment_score),
      network_score: toNumber(properties?.network_score),
      point_count: toNumber(properties?.point_count),
      quality_score: toNumber(properties?.quality_score),
      rack_count: toNumber(properties?.rack_count),
      snap_distance_m: toNumber(properties?.snap_distance_m),
      demand_score: toNumber(properties?.demand_score),
      total_weight: toNumber(properties?.total_weight),
    }
  }

  function toH3CellSummary(feature: MapGeoJSONFeature): H3CellSummary {
    const properties = feature.properties ?? {}

    return {
      bounds: parseBounds(properties.bounds),
      center: parseCoordinate(properties.center) ?? KRAKOW_CENTER,
      covered_segment_count: toNumber(properties.covered_segment_count),
      demand_score: toNumber(properties.demand_score),
      demand_weight: toNumber(properties.demand_weight),
      h3_index: toNullableString(properties.h3_index) ?? 'brak',
      h3_resolution: toNumber(properties.h3_resolution),
      hex_score: toNumber(properties.hex_score),
      infrastructure_count: toNumber(properties.infrastructure_count),
      max_noise_db: toNullableNumber(properties.max_noise_db),
      mean_greenery_ratio: toNumber(properties.mean_greenery_ratio),
      mean_segment_score: toNumber(properties.mean_segment_score),
      network_score: toNumber(properties.network_score),
      point_count: toNumber(properties.point_count),
      quality_score: toNumber(properties.quality_score),
      rack_count: toNumber(properties.rack_count),
      segment_sample_count: toNumber(properties.segment_sample_count),
    }
  }

  function segmentBreakdown(segment: TopSegment) {
    const weights = summary?.explainability.scoring.weights

    return [
      {
        id: 'greenery',
        label: scoreComponentMeta.greenery.label,
        note: scoreComponentMeta.greenery.note,
        raw: formatPercent(segment.greenery_ratio),
        score: segment.greenery_score,
        points: segment.greenery_points,
        weight: weights?.greenery ?? 0,
      },
      {
        id: 'noise',
        label: scoreComponentMeta.noise.label,
        note: scoreComponentMeta.noise.note,
        raw: formatNoise(segment.max_noise_db),
        score: segment.noise_score,
        points: segment.noise_points,
        weight: weights?.noise ?? 0,
      },
      {
        id: 'rack',
        label: scoreComponentMeta.rack.label,
        note: scoreComponentMeta.rack.note,
        raw: formatDistance(segment.nearest_rack_m),
        score: segment.rack_score,
        points: segment.rack_points,
        weight: weights?.rack ?? 0,
      },
      {
        id: 'infrastructure',
        label: scoreComponentMeta.infrastructure.label,
        note: scoreComponentMeta.infrastructure.note,
        raw: formatDistance(segment.nearest_infra_m),
        score: segment.infrastructure_score,
        points: segment.infrastructure_points,
        weight: weights?.infrastructure ?? 0,
      },
    ]
  }

  function formatWeight(weight: number) {
    return `${Math.round(weight * 100)}%`
  }

  function formatCoordinatePair(coordinate: [number, number] | null) {
    if (!coordinate) {
      return 'brak'
    }

    return `${coordinate[0].toFixed(4)}, ${coordinate[1].toFixed(4)}`
  }

  function formatFixed(value: number | null | undefined, digits = 2) {
    return value == null || !Number.isFinite(value) ? 'brak' : value.toFixed(digits)
  }

  function buildSegmentPopup(segment: TopSegment) {
    const breakdownHtml = segmentBreakdown(segment)
      .map(
        (item) => `
          <div class="rounded-xl bg-stone-50 px-3 py-2">
            <div class="flex items-center justify-between gap-3">
              <span class="font-medium text-stone-900">${escapeHtml(item.label)}</span>
              <span class="text-stone-900">${formatPoints(item.points)}</span>
            </div>
            <p class="mt-1 text-xs text-stone-500">${escapeHtml(item.raw)} • subscore ${formatScore(item.score)}/100 • waga ${escapeHtml(formatWeight(item.weight))}</p>
          </div>
        `,
      )
      .join('')

    return `
      <div class="w-[18rem] bg-white p-4 text-stone-900">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Segment #${segment.segment_id}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(segment.kind ?? 'nieopisany odcinek')}</h3>
            <p class="mt-1 text-xs text-stone-500">Ranking #${segment.score_rank ?? 'brak'}</p>
          </div>
          <span class="rounded-full px-3 py-1 text-sm font-semibold text-white" style="background:${scoreColor(segment.score)}">${formatScore(segment.score)}</span>
        </div>
        <dl class="grid grid-cols-2 gap-3 text-sm text-stone-700">
          <div><dt class="text-stone-500">Dlugosc</dt><dd class="font-medium text-stone-900">${formatKilometers(segment.length_km)}</dd></div>
          <div><dt class="text-stone-500">Nawierzchnia</dt><dd class="font-medium text-stone-900">${escapeHtml(segment.surface ?? 'brak')}</dd></div>
          <div><dt class="text-stone-500">Stojak</dt><dd class="font-medium text-stone-900">${formatDistance(segment.nearest_rack_m)}</dd></div>
          <div><dt class="text-stone-500">Infrastruktura</dt><dd class="font-medium text-stone-900">${formatDistance(segment.nearest_infra_m)}</dd></div>
          <div><dt class="text-stone-500">Zielen</dt><dd class="font-medium text-stone-900">${formatPercent(segment.greenery_ratio)}</dd></div>
          <div><dt class="text-stone-500">Max halas</dt><dd class="font-medium text-stone-900">${formatNoise(segment.max_noise_db)}</dd></div>
        </dl>
        <div class="mt-4 space-y-2">
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Wyjasnienie score</p>
          ${breakdownHtml}
        </div>
      </div>
    `
  }

  function buildCorridorPopup(corridor: RecommendedCorridor) {
    return `
      <div class="w-[19rem] bg-white p-4 text-stone-900">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Korytarz #${corridor.corridor_rank}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(corridor.label)}</h3>
          </div>
          <span class="rounded-full bg-sky-600 px-3 py-1 text-sm font-semibold text-white">${formatScore(corridor.mean_segment_score)}</span>
        </div>
        <dl class="grid grid-cols-2 gap-3 text-sm text-stone-700">
          <div><dt class="text-stone-500">Dlugosc trasy</dt><dd class="font-medium text-stone-900">${formatKilometers(corridor.path_length_km)}</dd></div>
          <div><dt class="text-stone-500">Odcinki</dt><dd class="font-medium text-stone-900">${formatCount(corridor.segment_count)}</dd></div>
          <div><dt class="text-stone-500">Dystans prosty</dt><dd class="font-medium text-stone-900">${formatKilometers(corridor.direct_distance_km)}</dd></div>
          <div><dt class="text-stone-500">Koszt sciezki</dt><dd class="font-medium text-stone-900">${corridor.path_cost.toFixed(1)}</dd></div>
          <div><dt class="text-stone-500">Sredni score</dt><dd class="font-medium text-stone-900">${formatScore(corridor.mean_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Sredni H3</dt><dd class="font-medium text-stone-900">${formatScore(corridor.mean_h3_score)}</dd></div>
          <div><dt class="text-stone-500">Min score</dt><dd class="font-medium text-stone-900">${formatScore(corridor.min_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Srednia zielen</dt><dd class="font-medium text-stone-900">${formatPercent(corridor.mean_greenery_ratio)}</dd></div>
          <div><dt class="text-stone-500">Max halas</dt><dd class="font-medium text-stone-900">${formatNoise(corridor.max_noise_db)}</dd></div>
        </dl>
      </div>
    `
  }

  function buildConnectorPopup(connector: RecommendedConnector) {
    return `
      <div class="w-[19rem] bg-white p-4 text-stone-900">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Lacznik #${connector.connector_rank}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(connector.label)}</h3>
          </div>
          <span class="rounded-full bg-red-500 px-3 py-1 text-sm font-semibold text-white">${formatScore(connector.priority_score)}</span>
        </div>
        <dl class="grid grid-cols-2 gap-3 text-sm text-stone-700">
          <div><dt class="text-stone-500">Dlugosc</dt><dd class="font-medium text-stone-900">${formatKilometers(connector.length_km)}</dd></div>
          <div><dt class="text-stone-500">Crossingi sieci</dt><dd class="font-medium text-stone-900">${formatCount(connector.network_crossings_count)}</dd></div>
          <div><dt class="text-stone-500">Zielen</dt><dd class="font-medium text-stone-900">${formatPercent(connector.greenery_ratio)}</dd></div>
          <div><dt class="text-stone-500">Max halas</dt><dd class="font-medium text-stone-900">${formatNoise(connector.max_noise_db)}</dd></div>
          <div><dt class="text-stone-500">Komponent docelowy</dt><dd class="font-medium text-stone-900">${escapeHtml(connector.target_component_label)}</dd></div>
          <div><dt class="text-stone-500">Priorytet</dt><dd class="font-medium text-stone-900">${formatScore(connector.priority_score)}</dd></div>
        </dl>
      </div>
    `
  }

  function buildHotspotPopup(hotspot: HotspotSummary) {
    return `
      <div class="w-[16rem] bg-white p-4 text-stone-900">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">H3 hub</p>
        <h3 class="mt-1 text-base font-semibold text-stone-950">${escapeHtml(hotspot.label)}</h3>
        <dl class="mt-3 space-y-2 text-sm text-stone-700">
          <div><dt class="text-stone-500">H3 score</dt><dd class="font-medium text-stone-900">${formatScore(hotspot.hex_score)}</dd></div>
          <div><dt class="text-stone-500">H3 index</dt><dd class="font-medium text-stone-900">${escapeHtml(hotspot.h3_index)}</dd></div>
          <div><dt class="text-stone-500">Wszystkie punkty</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.point_count)}</dd></div>
          <div><dt class="text-stone-500">Stojaki</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.rack_count)}</dd></div>
          <div><dt class="text-stone-500">Infrastruktura</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.infrastructure_count)}</dd></div>
          <div><dt class="text-stone-500">Sredni score segmentu</dt><dd class="font-medium text-stone-900">${formatScore(hotspot.mean_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Snap do grafu</dt><dd class="font-medium text-stone-900">${formatDistance(hotspot.snap_distance_m)}</dd></div>
        </dl>
      </div>
    `
  }

  function buildHexPopup(hex: H3CellSummary) {
    return `
      <div class="w-[18rem] bg-white p-4 text-stone-900">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">H3 cell</p>
        <h3 class="mt-1 text-base font-semibold text-stone-950">${escapeHtml(hex.h3_index)}</h3>
        <dl class="mt-3 space-y-2 text-sm text-stone-700">
          <div><dt class="text-stone-500">Hex score</dt><dd class="font-medium text-stone-900">${formatScore(hex.hex_score)}</dd></div>
          <div><dt class="text-stone-500">Demand score</dt><dd class="font-medium text-stone-900">${formatScore(hex.demand_score)}</dd></div>
          <div><dt class="text-stone-500">Network score</dt><dd class="font-medium text-stone-900">${formatScore(hex.network_score)}</dd></div>
          <div><dt class="text-stone-500">Quality score</dt><dd class="font-medium text-stone-900">${formatScore(hex.quality_score)}</dd></div>
          <div><dt class="text-stone-500">Punkty popytu</dt><dd class="font-medium text-stone-900">${formatCount(hex.point_count)}</dd></div>
          <div><dt class="text-stone-500">Probki segmentow</dt><dd class="font-medium text-stone-900">${formatCount(hex.segment_sample_count)}</dd></div>
          <div><dt class="text-stone-500">Sredni score segmentu</dt><dd class="font-medium text-stone-900">${formatScore(hex.mean_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Max halas</dt><dd class="font-medium text-stone-900">${formatNoise(hex.max_noise_db)}</dd></div>
        </dl>
      </div>
    `
  }

  function buildPointPopup(properties: Record<string, unknown> | undefined) {
    const pointKind = toNullableString(properties?.point_kind) === 'rack' ? 'Stojak' : 'Punkt infrastruktury'
    const name = escapeHtml(toNullableString(properties?.name) ?? 'brak nazwy')
    const type = escapeHtml(toNullableString(properties?.type) ?? 'brak typu')
    const status = escapeHtml(toNullableString(properties?.status) ?? 'brak statusu')
    const count = toNullableNumber(properties?.count)
    const description = escapeHtml(toNullableString(properties?.description) ?? 'brak opisu')

    return `
      <div class="w-[16rem] bg-white p-4 text-stone-900">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">${pointKind}</p>
        <h3 class="mt-1 text-base font-semibold text-stone-950">${name}</h3>
        <dl class="mt-3 space-y-2 text-sm text-stone-700">
          <div><dt class="text-stone-500">Typ</dt><dd class="font-medium text-stone-900">${type}</dd></div>
          <div><dt class="text-stone-500">Status</dt><dd class="font-medium text-stone-900">${status}</dd></div>
          <div><dt class="text-stone-500">Liczba</dt><dd class="font-medium text-stone-900">${count == null ? 'brak' : count}</dd></div>
          <div><dt class="text-stone-500">Opis</dt><dd class="font-medium text-stone-900">${description}</dd></div>
        </dl>
      </div>
    `
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Nie udalo sie pobrac ${url}. Najpierw uruchom npm run prepare:cycling-data.`)
    }

    return (await response.json()) as T
  }

  function parseBounds(value: unknown) {
    if (!Array.isArray(value) || value.length !== 4) {
      return null
    }

    const parsed = value.map((item) => Number(item))
    return parsed.every((item) => Number.isFinite(item))
      ? (parsed as [number, number, number, number])
      : null
  }

  function parseCoordinate(value: unknown) {
    if (!Array.isArray(value) || value.length < 2) {
      return null
    }

    const x = Number(value[0])
    const y = Number(value[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }

    return [x, y] as [number, number]
  }

  function toNumber(value: unknown) {
    return Number(value ?? 0)
  }

  function toNullableNumber(value: unknown) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }

  function toNullableString(value: unknown) {
    if (typeof value !== 'string') {
      return value == null ? null : String(value)
    }

    return value.length > 0 ? value : null
  }

  function escapeHtml(value: string) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }
</script>

<svelte:head>
  <title>KrakHack Smart Cycling Map</title>
  <meta
    name="description"
    content="Wizualizacja danych cycling-smart-city z preprocessingiem w Node i mapa w Svelte + MapLibre."
  />
</svelte:head>

<div class="min-h-screen bg-[radial-gradient(circle_at_top,_#fde68a,_#fff7ed_34%,_#f5f5f4_72%)] text-stone-950">
  <main class="mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
    <header class="grid gap-6 rounded-[2rem] border border-stone-300 bg-white/80 p-6 shadow-xl shadow-amber-100/60 backdrop-blur md:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)] md:p-8">
      <div class="space-y-4">
        <span class="inline-flex w-fit items-center rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-950">
          Smart Infrastructure Challenge
        </span>
        <div class="space-y-3">
          <h1 class="max-w-4xl font-serif text-4xl leading-tight tracking-tight text-stone-950 sm:text-5xl">
            Krakowskie trasy rowerowe zintegrowane z punktami infrastruktury, zielenią i hałasem.
          </h1>
          <p class="max-w-3xl text-base leading-8 text-stone-700 sm:text-lg">
            Preprocessing dzieje sie w Node na danych z paczki challenge, a frontend renderuje
            gotowe segmenty z policzonym komfortem. Dane sa osadzone na mapie Krakowa, zeby
            trasy i punkty byly czytelne przestrzennie, a nie wygladaly jak losowe linie.
          </p>
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
        <div class="rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4">
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Pipeline</p>
          <p class="mt-2 text-sm leading-7 text-stone-700">
            ZIP challenge -> normalizacja CRS -> scoring segmentow -> statyczne GeoJSON/JSON -> mapa.
          </p>
        </div>
        <div class="rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4">
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Deterministycznosc</p>
          <p class="mt-2 text-sm leading-7 text-stone-700">
            Warstwy analityczne sa statyczne i lokalne. Jedyny zewnetrzny element to podklad OSM,
            potrzebny tylko po to, zeby osadzic dane w realnym ukladzie ulic Krakowa.
          </p>
        </div>
      </div>
    </header>

    {#if error}
      <section class="rounded-[2rem] border border-red-200 bg-red-50 p-6 text-red-900 shadow-lg shadow-red-100/60">
        <h2 class="text-xl font-semibold">Nie udalo sie uruchomic wizualizacji</h2>
        <p class="mt-3 text-sm leading-7">{error}</p>
        <pre class="mt-4 overflow-x-auto rounded-2xl bg-white/80 p-4 text-xs text-stone-800">npm run prepare:cycling-data
npm run dev</pre>
      </section>
    {:else}
      <section class="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_24rem]">
        <div class="overflow-hidden rounded-[2rem] border border-stone-300 bg-white/82 shadow-xl shadow-amber-100/60 backdrop-blur">
          <div class="flex flex-col gap-4 border-b border-stone-200 px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Mapa</p>
                <h2 class="text-2xl font-semibold tracking-tight text-stone-950">
                  Segmenty, H3 i routing po score komorki
                </h2>
              </div>

              <div class="flex flex-wrap gap-2">
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showHexes ? 'bg-amber-500 text-stone-950' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showHexes} class="sr-only" type="checkbox" />
                  <span>H3</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showRacks ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showRacks} class="sr-only" type="checkbox" />
                  <span>Stojaki</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showInfrastructure ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showInfrastructure} class="sr-only" type="checkbox" />
                  <span>Punkty</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showHotspots ? 'bg-orange-500 text-white' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showHotspots} class="sr-only" type="checkbox" />
                  <span>Huby H3</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showCorridors ? 'bg-sky-600 text-white' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showCorridors} class="sr-only" type="checkbox" />
                  <span>Korytarze</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showConnectors ? 'bg-red-500 text-white' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showConnectors} class="sr-only" type="checkbox" />
                  <span>Laczniki</span>
                </label>
                <button
                  class={`rounded-full px-4 py-2 text-sm font-medium transition ${onlyTopSegments ? 'bg-amber-500 text-stone-950' : 'bg-stone-100 text-stone-700'}`}
                  onclick={() => (onlyTopSegments = !onlyTopSegments)}
                  type="button"
                >
                  {onlyTopSegments ? 'Pokazuje Top 20' : 'Wszystkie segmenty'}
                </button>
                <button
                  class="rounded-full bg-white px-4 py-2 text-sm font-medium text-stone-700 ring-1 ring-stone-300 transition hover:bg-stone-50"
                  onclick={resetView}
                  type="button"
                >
                  Widok Krakow
                </button>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              {#each scoreLegend as item}
                <div class="inline-flex items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700">
                  <span class="size-2.5 rounded-full" style={`background:${item.color}`}></span>
                  <span>{item.label}</span>
                </div>
              {/each}
              <div class="inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800">
                <span class="size-2.5 rounded-full bg-sky-600"></span>
                <span>Krakow / OSM</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
                <span class="size-2.5 rounded-full bg-amber-500"></span>
                <span>H3 score grid</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-xs font-medium text-orange-900">
                <span class="size-2.5 rounded-full bg-orange-500"></span>
                <span>H3 hub</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-900">
                <span class="size-2.5 rounded-full bg-sky-500"></span>
                <span>Rekomendowany korytarz</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-900">
                <span class="size-2.5 rounded-full bg-red-500"></span>
                <span>Nowy lacznik</span>
              </div>
            </div>
          </div>

          <div class="relative">
            <div bind:this={mapContainer} class="h-[70vh] min-h-[30rem] w-full"></div>

            {#if isLoading}
              <div class="absolute inset-0 flex items-center justify-center bg-white/65 backdrop-blur-sm">
                <div class="rounded-[1.5rem] border border-stone-200 bg-white px-5 py-4 text-sm font-medium text-stone-700 shadow-lg">
                  Wczytywanie mapy i warstw...
                </div>
              </div>
            {/if}
          </div>
        </div>

        <aside class="space-y-4">
          {#if summary}
            <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-4 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Sciezki</p>
                <p class="mt-2 text-3xl font-semibold tracking-tight text-stone-950">{summary.counts.cycling_path_segments}</p>
                <p class="mt-2 text-sm text-stone-600">Scoring policzony dla kazdego segmentu liniowego.</p>
              </div>
              <div class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-4 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Punkty</p>
                <p class="mt-2 text-3xl font-semibold tracking-tight text-stone-950">{summary.counts.bike_racks + summary.counts.bike_infrastructure_points}</p>
                <p class="mt-2 text-sm text-stone-600">Stojaki i punktowa infrastruktura rowerowa.</p>
              </div>
              <div class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-4 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Zielen</p>
                <p class="mt-2 text-3xl font-semibold tracking-tight text-stone-950">{summary.counts.greenery_polygons}</p>
                <p class="mt-2 text-sm text-stone-600">Poligony BDOT10k wpiete tylko do obliczen buforowych.</p>
              </div>
              <div class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-4 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Halas</p>
                <p class="mt-2 text-3xl font-semibold tracking-tight text-stone-950">{summary.counts.noise_polygons}</p>
                <p class="mt-2 text-sm text-stone-600">Poligony halasu znormalizowane do WGS84 przed analiza.</p>
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Score</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">Rozklad komfortu</h3>
                </div>
                <span class="rounded-full bg-stone-900 px-3 py-1 text-sm font-semibold text-stone-50">
                  mediana {formatScore(summary.score.median)}
                </span>
              </div>
              <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Min</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">{formatScore(summary.score.min)}</dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Max</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">{formatScore(summary.score.max)}</dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Srednia</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">{formatScore(summary.score.mean)}</dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Prog top 20</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">{formatScore(summary.top_score_threshold)}</dd>
                </div>
              </dl>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Corridor Engine</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    H3 + graf + Dijkstra
                  </h3>
                </div>
                <span class="rounded-full bg-sky-600 px-3 py-1 text-sm font-semibold text-white">
                  {summary.corridor_recommendations.recommended.length} tras
                </span>
              </div>
              <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Wezly grafu</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">
                    {summary.network_analysis.nodes}
                  </dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Krawedzie grafu</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">
                    {summary.network_analysis.edges}
                  </dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Aktywne heksy H3</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">
                    {summary.h3_grid.active_cells}
                  </dd>
                </div>
                <div class="rounded-2xl bg-stone-50 px-4 py-3">
                  <dt class="text-stone-500">Komponenty</dt>
                  <dd class="mt-1 text-lg font-semibold text-stone-950">
                    {summary.network_analysis.connected_components}
                  </dd>
                </div>
              </dl>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">H3 Grid</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Najmocniejsze komorki
                  </h3>
                </div>
                <span class="text-sm text-stone-500">klik = focus</span>
              </div>

              <div class="mt-4 space-y-2">
                {#each summary.h3_grid.top_cells.slice(0, 8) as hex}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedHex?.h3_index === hex.h3_index ? 'border-amber-500 bg-amber-500 text-stone-950 shadow-lg shadow-amber-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusHex(hex)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedHex?.h3_index === hex.h3_index ? 'text-amber-950/70' : 'text-stone-500'}`}>
                          res {hex.h3_resolution} • {hex.h3_index}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          hex {formatScore(hex.hex_score)} • demand {formatScore(hex.demand_score)}
                        </p>
                        <p class={`mt-1 text-xs ${selectedHex?.h3_index === hex.h3_index ? 'text-amber-950/70' : 'text-stone-500'}`}>
                          punkty {formatCount(hex.point_count)} • probki {formatCount(hex.segment_sample_count)}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedHex?.h3_index === hex.h3_index ? 'rgba(255,255,255,0.35)' : '#f59e0b'}; color:${selectedHex?.h3_index === hex.h3_index ? '#1c1917' : '#ffffff'}`}
                      >
                        {formatScore(hex.hex_score)}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </section>

            {#if selectedHex}
              <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrany H3 cell</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedHex.h3_index}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      resolution {selectedHex.h3_resolution}
                    </p>
                  </div>
                  <span class="rounded-full bg-amber-500 px-3 py-1 text-sm font-semibold text-stone-950">
                    {formatScore(selectedHex.hex_score)}
                  </span>
                </div>

                <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Demand score</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedHex.demand_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Network score</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedHex.network_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Quality score</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedHex.quality_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Waga popytu</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatFixed(selectedHex.demand_weight, 1)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Punkty</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatCount(selectedHex.point_count)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Probki segmentow</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatCount(selectedHex.segment_sample_count)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Sredni score segmentu</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedHex.mean_segment_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Max halas</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatNoise(selectedHex.max_noise_db)}</dd>
                  </div>
                </dl>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Korytarze</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Rekomendowane polaczenia
                  </h3>
                </div>
                <span class="text-sm text-stone-500">klik = focus</span>
              </div>

              <div class="mt-4 space-y-2">
                {#each summary.corridor_recommendations.recommended as corridor}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedCorridor?.corridor_id === corridor.corridor_id ? 'border-sky-700 bg-sky-700 text-white shadow-lg shadow-sky-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusCorridor(corridor)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedCorridor?.corridor_id === corridor.corridor_id ? 'text-sky-100' : 'text-stone-500'}`}>
                          #{corridor.corridor_rank} {corridor.from_label} -> {corridor.to_label}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          {corridor.path_length_km.toFixed(2)} km • {corridor.segment_count} odc.
                        </p>
                        <p class={`mt-1 text-xs ${selectedCorridor?.corridor_id === corridor.corridor_id ? 'text-sky-100' : 'text-stone-500'}`}>
                          score {formatScore(corridor.mean_segment_score)} • koszt {corridor.path_cost.toFixed(1)}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedCorridor?.corridor_id === corridor.corridor_id ? 'rgba(255,255,255,0.14)' : '#0ea5e9'}; color:#ffffff`}
                      >
                        {corridor.corridor_rank}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </section>

            {#if selectedCorridor}
              <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrany korytarz</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedCorridor.label}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      Korytarz #{selectedCorridor.corridor_rank}
                    </p>
                  </div>
                  <span class="rounded-full bg-sky-600 px-3 py-1 text-sm font-semibold text-white">
                    {formatScore(selectedCorridor.mean_segment_score)}
                  </span>
                </div>

                <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Dlugosc trasy</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatKilometers(selectedCorridor.path_length_km)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Dystans prosty</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatKilometers(selectedCorridor.direct_distance_km)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Koszt Dijkstra</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{selectedCorridor.path_cost.toFixed(1)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Liczba odcinkow</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{selectedCorridor.segment_count}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Sredni score</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedCorridor.mean_segment_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Sredni H3</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedCorridor.mean_h3_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Min score</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatScore(selectedCorridor.min_segment_score)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Srednia zielen</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPercent(selectedCorridor.mean_greenery_ratio)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Max halas</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatNoise(selectedCorridor.max_noise_db)}</dd>
                  </div>
                </dl>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Laczniki</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Propozycje nowych polaczen
                  </h3>
                </div>
                <span class="text-sm text-stone-500">klik = focus</span>
              </div>

              <div class="mt-4 space-y-2">
                {#each summary.off_network_connectors.recommended as connector}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedConnector?.connector_id === connector.connector_id ? 'border-red-600 bg-red-600 text-white shadow-lg shadow-red-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusConnector(connector)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedConnector?.connector_id === connector.connector_id ? 'text-red-100' : 'text-stone-500'}`}>
                          #{connector.connector_rank} {connector.source_component_label} -> {connector.target_component_label}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          {formatKilometers(connector.length_km)} • crossingi {formatCount(connector.network_crossings_count)}
                        </p>
                        <p class={`mt-1 text-xs ${selectedConnector?.connector_id === connector.connector_id ? 'text-red-100' : 'text-stone-500'}`}>
                          priorytet {formatScore(connector.priority_score)} • komponent {connector.target_component_id}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedConnector?.connector_id === connector.connector_id ? 'rgba(255,255,255,0.14)' : '#ef4444'}; color:#ffffff`}
                      >
                        {connector.connector_rank}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </section>

            {#if selectedConnector}
              <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrany lacznik</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedConnector.label}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      Lacznik #{selectedConnector.connector_rank}
                    </p>
                  </div>
                  <span class="rounded-full bg-red-500 px-3 py-1 text-sm font-semibold text-white">
                    {formatScore(selectedConnector.priority_score)}
                  </span>
                </div>

                <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Dlugosc</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatKilometers(selectedConnector.length_km)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Crossingi sieci</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatCount(selectedConnector.network_crossings_count)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Zielen</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPercent(selectedConnector.greenery_ratio)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Max halas</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatNoise(selectedConnector.max_noise_db)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Demand gain</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.demand_gain_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Network gain</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.network_gain_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Distance points</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.distance_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Crossing penalty</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.crossing_penalty_points)}</dd>
                  </div>
                </dl>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Top 20</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">Najlepsze odcinki</h3>
                </div>
                <span class="text-sm text-stone-500">klik = focus</span>
              </div>

              <div class="mt-4 space-y-2">
                {#each summary.top_segments as segment}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedSegment?.segment_id === segment.segment_id ? 'border-stone-900 bg-stone-900 text-stone-50 shadow-lg shadow-stone-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusSegment(segment)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedSegment?.segment_id === segment.segment_id ? 'text-stone-300' : 'text-stone-500'}`}>
                          #{segment.score_rank} segment {segment.segment_id}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          {segment.kind ?? 'nieopisany odcinek'}
                        </p>
                        <p class={`mt-1 text-xs ${selectedSegment?.segment_id === segment.segment_id ? 'text-stone-300' : 'text-stone-500'}`}>
                          {segment.surface ?? 'brak nawierzchni'} • {formatKilometers(segment.length_km)}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedSegment?.segment_id === segment.segment_id ? 'rgba(255,255,255,0.14)' : scoreColor(segment.score)}; color:${selectedSegment?.segment_id === segment.segment_id ? '#fafaf9' : '#ffffff'}`}
                      >
                        {formatScore(segment.score)}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </section>

            {#if selectedSegment}
              <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrany segment</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedSegment.kind ?? 'nieopisany odcinek'}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      Segment #{selectedSegment.segment_id} • ranking #{selectedSegment.score_rank ?? 'brak'}
                    </p>
                  </div>
                  <span class="rounded-full px-3 py-1 text-sm font-semibold text-white" style={`background:${scoreColor(selectedSegment.score)}`}>
                    {formatScore(selectedSegment.score)}
                  </span>
                </div>

                <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Dlugosc</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatKilometers(selectedSegment.length_km)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Nawierzchnia</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{selectedSegment.surface ?? 'brak'}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Najblizszy stojak</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatDistance(selectedSegment.nearest_rack_m)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Najblizszy punkt</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatDistance(selectedSegment.nearest_infra_m)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Pokrycie zieleni</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPercent(selectedSegment.greenery_ratio)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Max halas</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatNoise(selectedSegment.max_noise_db)}</dd>
                  </div>
                </dl>

                <div class="mt-5">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Why this score</p>
                      <h4 class="mt-1 text-base font-semibold text-stone-950">Rozbicie punktacji</h4>
                    </div>
                    <span class="rounded-full bg-stone-900 px-3 py-1 text-xs font-semibold text-stone-50">
                      suma {formatPoints(selectedSegment.score)}
                    </span>
                  </div>

                  <div class="mt-4 space-y-3">
                    {#each segmentBreakdown(selectedSegment) as item}
                      <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <p class="text-sm font-semibold text-stone-950">{item.label}</p>
                            <p class="mt-1 text-xs leading-6 text-stone-500">{item.note}</p>
                          </div>
                          <div class="text-right">
                            <p class="text-sm font-semibold text-stone-950">{formatPoints(item.points)}</p>
                            <p class="mt-1 text-xs text-stone-500">waga {formatWeight(item.weight)}</p>
                          </div>
                        </div>
                        <div class="mt-3 flex items-center justify-between gap-3 text-sm text-stone-700">
                          <span>wartosc: {item.raw}</span>
                          <span>subscore: {formatScore(item.score)}/100</span>
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">H3 huby</p>
              <div class="mt-4 space-y-2">
                {#each summary.corridor_recommendations.hotspots as hotspot}
                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class="text-sm font-semibold text-stone-950">{hotspot.label}</p>
                        <p class="mt-1 text-xs text-stone-500">
                          {hotspot.point_count} punktow • stojaki {hotspot.rack_count} • infrastruktura {hotspot.infrastructure_count}
                        </p>
                        <p class="mt-1 text-xs text-stone-500">
                          H3 {hotspot.h3_index}
                        </p>
                      </div>
                      <div class="text-right">
                        <p class="text-sm font-semibold text-stone-950">{formatScore(hotspot.hex_score)}</p>
                        <p class="mt-1 text-xs text-stone-500">hex score</p>
                      </div>
                    </div>
                    <p class="mt-2 text-xs text-stone-600">
                      Snap do wezla grafu: {formatDistance(hotspot.snap_distance_m)} • quality {formatScore(hotspot.quality_score)}
                    </p>
                  </div>
                {/each}
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Spatial Stats</p>
              <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Punkty popytu</p>
                  <p class="mt-1 text-xs text-stone-500">
                    mean center: {formatCoordinatePair(summary.spatial_statistics.demand_points.mean_center)}
                  </p>
                  <p class="mt-2 text-sm text-stone-700">
                    NNI {formatFixed(summary.spatial_statistics.demand_points.nearest_neighbor_index?.nni, 3)} • {summary.spatial_statistics.demand_points.nearest_neighbor_index?.pattern ?? 'brak'}
                  </p>
                </div>
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Stojaki</p>
                  <p class="mt-1 text-xs text-stone-500">
                    mean center: {formatCoordinatePair(summary.spatial_statistics.bike_racks.mean_center)}
                  </p>
                  <p class="mt-2 text-sm text-stone-700">
                    NNI {formatFixed(summary.spatial_statistics.bike_racks.nearest_neighbor_index?.nni, 3)} • {summary.spatial_statistics.bike_racks.nearest_neighbor_index?.pattern ?? 'brak'}
                  </p>
                </div>
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Infrastruktura</p>
                  <p class="mt-1 text-xs text-stone-500">
                    mean center: {formatCoordinatePair(summary.spatial_statistics.bike_infrastructure.mean_center)}
                  </p>
                  <p class="mt-2 text-sm text-stone-700">
                    NNI {formatFixed(summary.spatial_statistics.bike_infrastructure.nearest_neighbor_index?.nni, 3)} • {summary.spatial_statistics.bike_infrastructure.nearest_neighbor_index?.pattern ?? 'brak'}
                  </p>
                </div>
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Elipsa hubow H3</p>
                  <p class="mt-2 text-sm text-stone-700">
                    major {formatFixed(summary.spatial_statistics.hotspot_centers.standard_deviational_ellipse?.major_axis_sd_m, 0)} m • minor {formatFixed(summary.spatial_statistics.hotspot_centers.standard_deviational_ellipse?.minor_axis_sd_m, 0)} m
                  </p>
                </div>
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Explainability</p>
              <div class="mt-3 space-y-4 text-sm leading-7 text-stone-700">
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Formula</p>
                  <p class="mt-2 font-medium text-stone-950">{summary.explainability.scoring.formula}</p>
                  <p class="mt-2 text-stone-600">
                    Probkowanie: co {summary.explainability.scoring.sample_step_meters} m • zakres wyniku {summary.explainability.scoring.output_range[0]}-{summary.explainability.scoring.output_range[1]}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">H3 Indexing</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.h3_indexing.scenario.cell_score_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    resolution {summary.explainability.h3_indexing.scenario.resolution} • huby {summary.explainability.h3_indexing.scenario.hub_count}
                  </p>
                  <p class="mt-2 text-stone-600">
                    demand: {summary.explainability.h3_indexing.scenario.demand_score_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    network: {summary.explainability.h3_indexing.scenario.network_score_formula} • quality: {summary.explainability.h3_indexing.scenario.quality_score_formula}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Corridor Optimization</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.corridor_optimization.scenario.edge_cost_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Priorytet pary: {summary.explainability.corridor_optimization.scenario.pair_priority_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Snap grafu: {summary.explainability.corridor_optimization.graph_snap_decimals} cyfr • H3 res {summary.explainability.corridor_optimization.scenario.h3_resolution} • huby {summary.explainability.corridor_optimization.scenario.hub_count}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Connector Optimization</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.connector_optimization.scenario.priority_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Dlugosc {summary.explainability.connector_optimization.scenario.min_connector_length_meters}-{summary.explainability.connector_optimization.scenario.max_connector_length_meters} m • targety {summary.explainability.connector_optimization.scenario.target_component_limit}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Crossing method: {summary.explainability.connector_optimization.scenario.crossing_method}
                  </p>
                </div>

                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Kolejnosc obliczen</p>
                  <div class="mt-3 space-y-2">
                    {#each summary.explainability.processing_steps as step}
                      <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                        <div class="flex items-center justify-between gap-3">
                          <p class="text-sm font-semibold text-stone-950">{step.title}</p>
                          <span class="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-stone-500 ring-1 ring-stone-200">
                            {step.step}
                          </span>
                        </div>
                        <p class="mt-2 text-sm leading-6 text-stone-600">{step.description}</p>
                      </div>
                    {/each}
                  </div>
                </div>
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Zrodla danych</p>
              <div class="mt-4 space-y-3">
                {#each summary.explainability.data_sources as source}
                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class="text-sm font-semibold text-stone-950">{source.label}</p>
                        <p class="mt-1 break-all font-mono text-xs text-stone-500">{source.file}</p>
                      </div>
                      <span class="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500 ring-1 ring-stone-200">
                        {source.geometry}
                      </span>
                    </div>
                    <p class="mt-3 text-xs text-stone-600">
                      {source.source_crs} -> {source.normalized_crs}
                    </p>
                    <p class="mt-2 text-sm text-stone-700">{source.usage.join(' • ')}</p>
                  </div>
                {/each}
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Kolejnosc warstw</p>
              <div class="mt-4 space-y-2">
                {#each summary.explainability.map_layers as layer}
                  <div class="flex items-center justify-between gap-3 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
                    <div>
                      <p class="font-semibold text-stone-950">{layer.id}</p>
                      <p class="mt-1 text-stone-600">{layer.role}</p>
                    </div>
                    <div class="text-right">
                      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                        #{layer.order}
                      </p>
                      <p class="mt-1 text-xs text-stone-500">{layer.data_source}</p>
                    </div>
                  </div>
                {/each}
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Ograniczenia</p>
              <div class="mt-4 space-y-2">
                {#each summary.explainability.limitations as item}
                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-700">
                    {item}
                  </div>
                {/each}
                {#each summary.explainability.nondeterminism as item}
                  <div class="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                    Niedeterminizm: {item}
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        </aside>
      </section>
    {/if}
  </main>
</div>
