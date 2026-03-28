<script lang="ts">
  import { afterUpdate, onDestroy, onMount } from 'svelte'
  import type {
    GeoJSONSource,
    Map as MapLibreMap,
    MapGeoJSONFeature,
    Popup as MapLibrePopup,
  } from 'maplibre-gl'
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
    type HexFeatureCollection,
    type HotspotSummary,
    type RecommendedConnector,
    type RecommendedCorridor,
    type RouteMarker,
    type RouteResult,
    type RoutingGraph,
    type SegmentFeatureCollection,
    type Summary,
    type TopSegment,
  } from './lib/smart-city'
  import {
    buildRoutingGraph,
    findNearestNode,
    astar,
    buildVibeEdgeCosts,
    computeIsochrone,
    computeCentrality,
    preloadH3,
    type VibeWeights,
  } from './lib/routing'
  import type { IsochroneResult, CentralityResult } from './lib/smart-city'

  const SUMMARY_URL = '/generated/cycling-smart-city/summary.json'
  const SEGMENTS_URL = '/generated/cycling-smart-city/segments.geojson'
  const POINTS_URL = '/generated/cycling-smart-city/points.geojson'
  const HEXES_URL = '/generated/cycling-smart-city/hexes.geojson'
  const HOTSPOTS_URL = '/generated/cycling-smart-city/hotspots.geojson'
  const CORRIDORS_URL = '/generated/cycling-smart-city/corridors.geojson'
  const CONNECTORS_URL = '/generated/cycling-smart-city/connectors.geojson'
  const KRAKOW_PREVIEW_MARGIN_RATIO = 1
  const KRAKOW_PREVIEW_MIN_ZOOM = 7.8

  let mapContainer: HTMLDivElement
  let maplibreModule: typeof import('maplibre-gl') | null = null
  let map: MapLibreMap | null = null
  let popup: MapLibrePopup | null = null

  let summary: Summary | null = null
  let rawHexes: HexFeatureCollection | null = null
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
  let showHotspots = false
  let showCorridors = false
  let showConnectors = false
  let onlyTopSegments = false

  // --- Routing A→B state ---
  let routingGraph: RoutingGraph | null = null
  let routingMode: 'idle' | 'selectStart' | 'selectEnd' = 'idle'
  let routeStart: RouteMarker | null = null
  let routeEnd: RouteMarker | null = null
  let routeResult: RouteResult | null = null
  let routeError: string | null = null
  let isGraphBuilding = false
  let routeVibeLevel = 2
  let showRoute = true
  let routeVibeSearch = ''
  const MIN_ROUTE_VIBE_LEVEL = 1
  const MAX_ROUTE_VIBE_LEVEL = 10

  // --- Isochrone state ---
  let isochroneResult: IsochroneResult | null = null
  let isochroneMode = false
  let showIsochrone = true

  // --- Centrality state ---
  let centralityResult: CentralityResult | null = null
  let showBetweenness = false
  let isCentralityComputing = false

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
      note: 'Im mniejszy halas, tym wyzszy wynik czastkowy.',
    },
    rack: {
      label: 'Stojaki',
      note: 'Im blizej stojaka, tym wyzszy wynik czastkowy.',
    },
    infrastructure: {
      label: 'Infrastruktura',
      note: 'Im blizej punktowej infrastruktury, tym wyzszy wynik czastkowy.',
    },
  } as const

  type VibeMetricKey =
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

  type VibeDefinition = {
    color: string
    formula: string
    id: string
    isCustom: boolean
    label: string
    weights: Record<VibeMetricKey, number>
  }

  type VibeAnalysis = {
    color: string
    dominant: { label: string; score: number } | null
    opacity: number
    scores: Array<{
      color: string
      contributions: Array<{
        affinity: number
        key: VibeMetricKey
        label: string
        raw: number
        weight: number
      }>
      formula: string
      id: string
      isCustom: boolean
      label: string
      score: number
    }>
  }

  type LegendDoc = {
    formula: string
    kind: string
    label: string
    meaning: string
    source: string
  }

  type DataDocItem = {
    code?: string
    formula: string
    label: string
    note?: string
    source: string
    usage: string
    valueType: string
  }

  type DataDocSection = {
    intro: string
    items: DataDocItem[]
    title: string
  }

  type MockVibeSuggestion = {
    id: string
    imagePath: string
    note: string
    title: string
    vibeIds: string[]
  }

  const emptyHexFeatureCollection: HexFeatureCollection = {
    type: 'FeatureCollection',
    features: [],
  }

  type MapBoundsLike = [[number, number], [number, number]]

  const vibeMetricMeta: Array<{ key: VibeMetricKey; label: string; note: string }> = [
    {
      key: 'air_proxy',
      label: 'Jakość powietrza (przybliżenie)',
      note: 'Przybliżenie jakości powietrza liczone z zieleni i spokoju akustycznego: 55% score zieleni + 45% score ciszy. To przybliżenie, bo w paczce nie ma osobnej warstwy jakości powietrza.',
    },
    {
      key: 'greenery',
      label: 'Zieleń otoczenia',
      note: 'Średni score zieleni segmentów w heksie.',
    },
    {
      key: 'quietness',
      label: 'Spokój akustyczny',
      note: 'Średni score hałasu segmentów; wyżej = ciszej.',
    },
    {
      key: 'rack_access',
      label: 'Dostep do stojakow',
      note: 'Średni score dostępu do stojaków; wyżej = łatwiejszy dostęp.',
    },
    {
      key: 'infrastructure_access',
      label: 'Dostep do infrastruktury',
      note: 'Średni score dostępu do infrastruktury; wyżej = lepszy dostęp.',
    },
    {
      key: 'rack_density',
      label: 'Gęstość stojaków',
      note: 'Znormalizowana liczba stojaków w heksie.',
    },
    {
      key: 'infrastructure_density',
      label: 'Gęstość infrastruktury',
      note: 'Znormalizowana liczba punktów infrastruktury w heksie.',
    },
    {
      key: 'demand',
      label: 'Popyt',
      note: 'Znormalizowany popyt z punktów i wag: stojak = 1, punkt infrastruktury = 2.5.',
    },
    {
      key: 'network',
      label: 'Obecność sieci rowerowej',
      note: 'Znormalizowana liczba próbek segmentów wpadających do heksa.',
    },
    {
      key: 'quality',
      label: 'Ogólna jakość segmentów',
      note: 'Średni końcowy score segmentów w heksie. To nie jest pojedyncza warstwa, tylko średnia jakości już policzonych segmentów.',
    },
  ]

  const pureMetricColorByKey: Record<VibeMetricKey, string> = {
    air_proxy: '#0f766e',
    demand: '#ea580c',
    greenery: '#16a34a',
    infrastructure_access: '#2563eb',
    infrastructure_density: '#1d4ed8',
    network: '#4f46e5',
    quality: '#7c3aed',
    quietness: '#0891b2',
    rack_access: '#0284c7',
    rack_density: '#14b8a6',
  }

  const mockVibeSuggestions: MockVibeSuggestion[] = [
    {
      id: 'dune',
      imagePath: '/Dune-3.webp',
      title: 'Post-apo',
      note: 'Vibe dnia: po premierze trailera DUNE 3 proponujemy pustynny, surowy vibe i polecamy zalozyc maske.',
      vibeIds: ['post_apo'],
    },
    {
      id: 'green-ride',
      imagePath: '/green.jpg',
      title: 'Zdrowie + Slow',
      note: 'Na spokojny przejazd przez zielen, cisze i miejsca z lepszym dostepem do stojakow.',
      vibeIds: ['health', 'slow'],
    },
    {
      id: 'city-flow',
      imagePath: '/krakow.jpg',
      title: 'Miejski przeplyw',
      note: 'Gdy chcesz sprawnie przejechac przez miasto i trzymac sie mocniejszej sieci rowerowej.',
      vibeIds: ['urban_flow'],
    },
  ]

  const mixedVibes: VibeDefinition[] = [
    {
      id: 'health',
      label: 'Zdrowie',
      color: '#16a34a',
      isCustom: false,
      formula:
        'jakość powietrza (+45) + zieleń otoczenia (+20) + spokój akustyczny (+15) + ogólna jakość segmentów (+10) + dostęp do infrastruktury (+10)',
      weights: {
        air_proxy: 45,
        demand: 0,
        greenery: 20,
        infrastructure_access: 10,
        infrastructure_density: 0,
        network: 0,
        quality: 10,
        quietness: 15,
        rack_access: 0,
        rack_density: 0,
      },
    },
    {
      id: 'slow',
      label: 'Slow',
      color: '#38bdf8',
      isCustom: false,
      formula:
        'dostęp do stojaków (+30) + gęstość stojaków (+25) + zieleń otoczenia (+20) + spokój akustyczny (+15) + popyt (-10)',
      weights: {
        air_proxy: 0,
        demand: -10,
        greenery: 20,
        infrastructure_access: 0,
        infrastructure_density: 0,
        network: 0,
        quality: 0,
        quietness: 15,
        rack_access: 30,
        rack_density: 25,
      },
    },
    {
      id: 'urban_flow',
      label: 'Miejski przeplyw',
      color: '#2563eb',
      isCustom: false,
      formula:
        'popyt (+35) + obecność sieci rowerowej (+25) + gęstość infrastruktury (+20) + dostęp do infrastruktury (+10) + ogólna jakość segmentów (+10)',
      weights: {
        air_proxy: 0,
        demand: 35,
        greenery: 0,
        infrastructure_access: 10,
        infrastructure_density: 20,
        network: 25,
        quality: 10,
        quietness: 0,
        rack_access: 0,
        rack_density: 0,
      },
    },
    {
      id: 'post_apo',
      label: 'Post-apo',
      color: '#ef4444',
      isCustom: false,
      formula:
        'jakość powietrza (-35) + spokój akustyczny (-20) + zieleń otoczenia (-15) + dostęp do infrastruktury (-15) + ogólna jakość segmentów (-15)',
      weights: {
        air_proxy: -35,
        demand: 0,
        greenery: -15,
        infrastructure_access: -15,
        infrastructure_density: 0,
        network: 0,
        quality: -15,
        quietness: -20,
        rack_access: 0,
        rack_density: 0,
      },
    },
  ]

  const pureMetricVibes: VibeDefinition[] = vibeMetricMeta.map((metric) => ({
    id: `pure_${metric.key}`,
    label: `${metric.label} 100%`,
    color: pureMetricColorByKey[metric.key],
    isCustom: false,
    formula: `${metric.label.toLowerCase()} (+100)`,
    weights: {
      ...createEmptyVibeWeights(),
      [metric.key]: 100,
    },
  }))

  const metricLegendSections: Array<{
    title: string
    items: Array<{ code?: string; label: string; note: string }>
  }> = [
    {
      title: 'Segment',
      items: [
        {
          code: 'score',
          label: 'Score segmentu',
          note: 'Finalna ocena segmentu 0-100. To wazona suma score zieleni, halasu, stojakow i infrastruktury.',
        },
        {
          code: 'greenery_ratio',
          label: 'Pokrycie zieleni',
          note: 'Procent probek segmentu, ktore wpadaja w poligony zieleni.',
        },
        {
          code: 'max_noise_db',
          label: 'Maksymalny halas',
          note: 'Najwyzszy odczyt halasu przypisany do probek segmentu.',
        },
        {
          code: 'nearest_rack_m',
          label: 'Najblizszy stojak',
          note: 'Odleglosc segmentu do najblizszego stojaka rowerowego.',
        },
        {
          code: 'nearest_infra_m',
          label: 'Najblizszy punkt infrastruktury',
          note: 'Odleglosc segmentu do najblizszego punktu infrastruktury rowerowej.',
        },
      ],
    },
    {
      title: 'H3',
      items: [
        {
          code: 'hex_score',
          label: 'Score heksa',
          note: 'Jawna ocena komorki H3. Wzor: popyt 45% + siec 20% + jakosc segmentow 35%.',
        },
        {
          code: 'demand_score',
          label: 'Score popytu',
          note: 'Znormalizowana sila popytu z punktow w danym heksie.',
        },
        {
          code: 'network_score',
          label: 'Score sieci',
          note: 'Znormalizowana liczba probek segmentow wpadajacych do heksa.',
        },
        {
          code: 'quality_score',
          label: 'Ogólna jakość segmentów',
          note: 'Średni końcowy score segmentów przypisanych do heksa.',
        },
        {
          code: 'point_count',
          label: 'Liczba punktow',
          note: 'Suma punktow popytu w heksie: stojaki + punktowa infrastruktura.',
        },
        {
          code: 'segment_sample_count',
          label: 'Liczba probek segmentow',
          note: 'Ile probek z geometrii segmentow wpada do danego heksa.',
        },
        {
          code: 'covered_segment_count',
          label: 'Liczba segmentow pokrytych',
          note: 'Ile unikalnych segmentow przechodzi przez dany heks.',
        },
        {
          code: 'total_segment_length_km',
          label: 'Laczna dlugosc segmentow',
          note: 'Suma dlugosci segmentow przypisanych do heksa.',
        },
        ...vibeMetricMeta.map((metric) => ({
          code: metric.key,
          label: metric.label,
          note: metric.note,
        })),
      ],
    },
    {
      title: 'Korytarze i łączniki',
      items: [
        {
          code: 'path_cost',
          label: 'Koszt trasy',
          note: 'Koszt przejscia po grafie Dijkstra; im nizszy, tym latwiejszy przejazd wg wybranego scenariusza.',
        },
        {
          code: 'pair_priority',
          label: 'Priorytet pary hubow',
          note: 'Sila kandydatury pary hubow przed uruchomieniem trasowania.',
        },
        {
          code: 'priority_score',
          label: 'Priorytet łącznika',
          note: 'Finalna punktacja kandydata nowego łącznika między komponentami.',
        },
        {
          code: 'demand_gain_points',
          label: 'Zysk popytu',
          note: 'Ile punktów łącznik zyskuje za dołączenie komponentu z popytem.',
        },
        {
          code: 'network_gain_points',
          label: 'Zysk sieci',
          note: 'Ile punktów łącznik zyskuje za poprawienie spójności sieci.',
        },
        {
          code: 'distance_points',
          label: 'Punkty za dystans',
          note: 'Premia za krótszy łącznik w dopuszczalnym przedziale odległości.',
        },
        {
          code: 'crossing_penalty_points',
          label: 'Kara za przeciecia',
          note: 'Odjeta liczba punktow za przeciecia z istniejacymi segmentami sieci.',
        },
      ],
    },
  ]

  let customVibes: VibeDefinition[] = []
  let enabledVibeIds = mixedVibes.map((vibe) => vibe.id)
  let customVibeLabel = 'Wlasny vibe'
  let customVibeColor = '#2563eb'
  let customVibeWeights = createEmptyVibeWeights()
  let selectedCorridorScenarioId: string | null = null
  let catalogVibeList: VibeDefinition[] = []
  let activeVibeList: VibeDefinition[] = []
  let availableRouteVibeList: VibeDefinition[] = []
  let hasVisiblePointMarkers = true

  $: catalogVibeList = [...mixedVibes, ...pureMetricVibes, ...customVibes]
  $: activeVibeList = catalogVibeList.filter((vibe) => enabledVibeIds.includes(vibe.id))
  $: hasVisiblePointMarkers = showRacks || showInfrastructure || showHotspots
  $: {
    const query = normalizeSearchValue(routeVibeSearch)
    availableRouteVibeList = catalogVibeList.filter((vibe) => {
      if (enabledVibeIds.includes(vibe.id)) {
        return false
      }

      if (!query) {
        return false
      }

      const searchable = normalizeSearchValue(
        `${vibe.label} ${vibe.formula} ${vibeKindLabel(vibe)}`,
      )

      return searchable.includes(query)
    })
  }

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
    syncHexData()
    syncHexVisibility()
    syncPointVisibility()
    syncHotspotVisibility()
    syncCorridorVisibility()
    syncConnectorVisibility()
    syncSegmentFilter()
    syncSelectedSegment()
    syncSelectedCorridor()
    syncSelectedConnector()
    syncRouteDisplay()
  })

  async function initialize() {
    isLoading = true
    isMapReady = false
    error = null

    try {
      const [summaryResponse, hexesResponse, segmentsResponse] = await Promise.all([
        fetchJson<Summary>(SUMMARY_URL),
        fetchJson<HexFeatureCollection>(HEXES_URL),
        fetchJson<SegmentFeatureCollection>(SEGMENTS_URL),
      ])
      summary = summaryResponse
      rawHexes = hexesResponse

      // Build routing graph in background (non-blocking for map load)
      buildGraphAsync(segmentsResponse, hexesResponse)
      selectedCorridorScenarioId = summary.corridor_recommendations.scenario.id
      selectedSegment = summary.top_segments[0] ?? null
      selectedCorridor = selectedCorridorScenario()?.recommended[0] ?? null
      selectedConnector = summary.off_network_connectors.recommended[0] ?? null
      selectedHex = getHexByIndex(summary.h3_grid.top_cells[0]?.h3_index) ?? summary.h3_grid.top_cells[0] ?? null
      const previewBounds = buildPreviewBounds(summaryResponse.bounds)

      maplibreModule = await import('maplibre-gl')

      map = new maplibreModule.Map({
        container: mapContainer,
        style: MAP_STYLE,
        attributionControl: { compact: true },
        maxBounds: previewBounds,
        minZoom: KRAKOW_PREVIEW_MIN_ZOOM,
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
      data: buildRenderedHexCollection(),
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

    currentMap.addSource('route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })

    currentMap.addSource('route-markers', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })

    currentMap.addSource('isochrone', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })

    currentMap.addSource('centrality', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
  }

  function addLayers(currentMap: MapLibreMap) {
    currentMap.addLayer({
      id: 'hexes-fill',
      type: 'fill',
      source: 'hexes',
      paint: {
        'fill-color': ['coalesce', ['get', 'display_color'], '#60a5fa'],
        'fill-opacity': ['coalesce', ['get', 'display_opacity'], 0.3],
        'fill-outline-color': ['coalesce', ['get', 'display_outline_color'], '#1d4ed8'],
      },
    })

    // Isochrone bands (below segments, above hexes)
    currentMap.addLayer({
      id: 'isochrone-fill',
      type: 'fill',
      source: 'isochrone',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.22,
      },
    })

    currentMap.addLayer({
      id: 'isochrone-outline',
      type: 'line',
      source: 'isochrone',
      layout: { visibility: 'none' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2.5,
        'line-opacity': 0.7,
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

    // Betweenness centrality overlay (above segments)
    currentMap.addLayer({
      id: 'centrality-layer',
      type: 'line',
      source: 'centrality',
      layout: { visibility: 'none' },
      paint: {
        'line-color': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'normalized'], 0],
          0, '#fef3c7',
          0.2, '#f59e0b',
          0.5, '#ef4444',
          1, '#7f1d1d',
        ],
        'line-width': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'normalized'], 0],
          0, 2,
          1, 10,
        ],
        'line-opacity': 0.85,
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

    // --- Route A→B layers (on top of everything) ---
    currentMap.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#1e293b',
        'line-width': 10,
        'line-opacity': 0.7,
      },
    })

    currentMap.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#8b5cf6',
        'line-width': 5.5,
        'line-opacity': 0.95,
      },
    })

    currentMap.addLayer({
      id: 'route-markers',
      type: 'circle',
      source: 'route-markers',
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 10,
        'circle-color': [
          'match',
          ['get', 'kind'],
          'start', '#22c55e',
          'end', '#ef4444',
          '#8b5cf6',
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3,
      },
    })

    currentMap.addLayer({
      id: 'route-markers-label',
      type: 'symbol',
      source: 'route-markers',
      layout: {
        visibility: 'none',
        'text-field': ['get', 'label'],
        'text-size': 13,
        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': '#ffffff',
      },
    })
  }

  function bindMapEvents(currentMap: MapLibreMap) {
    // Routing/isochrone mode: intercept all clicks on the map
    currentMap.on('click', (event) => {
      if (isochroneMode) {
        handleIsochroneClick(event.lngLat)
        return
      }
      if (routingMode !== 'idle') {
        handleRoutingClick(event.lngLat)
      }
    })

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
        if (routingMode !== 'idle' || isochroneMode) {
          currentMap.getCanvas().style.cursor = 'crosshair'
        } else {
          currentMap.getCanvas().style.cursor = 'pointer'
        }
      })
      currentMap.on('mouseleave', layerId, () => {
        if (routingMode !== 'idle' || isochroneMode) {
          currentMap.getCanvas().style.cursor = 'crosshair'
        } else {
          currentMap.getCanvas().style.cursor = ''
        }
      })
    }

    currentMap.on('click', 'hexes-fill', (event) => {
      if (routingMode !== 'idle' || isochroneMode) return
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const clickedIndex = toNullableString(feature.properties?.h3_index)
      const hex = (clickedIndex ? getHexByIndex(clickedIndex) : null) ?? toH3CellSummary(feature)
      selectedHex = hex
      renderPopup(event.lngLat, buildHexPopup(hex))
    })

    const handleSegmentClick = (event: {
      features?: MapGeoJSONFeature[]
      lngLat: { lat: number; lng: number }
    }) => {
      if (routingMode !== 'idle' || isochroneMode) return
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
      if (routingMode !== 'idle' || isochroneMode) return
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const corridor = toRecommendedCorridor(feature)
      selectedCorridor = corridor
      renderPopup(event.lngLat, buildCorridorPopup(corridor))
    })

    currentMap.on('click', 'connectors-fill', (event) => {
      if (routingMode !== 'idle' || isochroneMode) return
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      const connector = toRecommendedConnector(feature)
      selectedConnector = connector
      renderPopup(event.lngLat, buildConnectorPopup(connector))
    })

    currentMap.on('click', 'hotspots', (event) => {
      if (routingMode !== 'idle' || isochroneMode) return
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      renderPopup(event.lngLat, buildHotspotPopup(toHotspotSummary(feature.properties)))
    })

    currentMap.on('click', 'points-racks', (event) => {
      if (routingMode !== 'idle' || isochroneMode) return
      const feature = event.features?.[0]
      if (!feature) {
        return
      }

      renderPopup(event.lngLat, buildPointPopup(feature.properties))
    })

    currentMap.on('click', 'points-infrastructure', (event) => {
      if (routingMode !== 'idle' || isochroneMode) return
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

  function syncHexData() {
    if (!map || !isMapReady) {
      return
    }

    const source = map.getSource('hexes') as GeoJSONSource | undefined
    if (!source) {
      return
    }

    source.setData(buildRenderedHexCollection())
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

    map.setFilter(
      'hotspots',
      selectedCorridorScenarioId ? ['==', 'scenario_id', selectedCorridorScenarioId] : null,
    )
    setLayerVisibility('hotspots', showHotspots)
  }

  function syncHexVisibility() {
    if (!map || !isMapReady) {
      return
    }

    setLayerVisibility('hexes-fill', showHexes)
  }

  function buildRenderedHexCollection(): HexFeatureCollection {
    if (!rawHexes) {
      return emptyHexFeatureCollection
    }

    return {
      type: 'FeatureCollection',
      features: rawHexes.features.map((feature) => {
        const vibe = analyzeHexVibes(feature.properties)

        return {
          ...feature,
          properties: {
            ...feature.properties,
            display_color: vibe.color,
            display_outline_color: darkenHexColor(vibe.color, 0.28),
            display_opacity: vibe.opacity,
            dominant_vibe: vibe.dominant?.label ?? null,
          },
        }
      }),
    }
  }

  function getHexByIndex(h3Index: string | null | undefined) {
    if (!h3Index || !rawHexes) {
      return null
    }

    const feature = rawHexes.features.find((candidate) => candidate.properties.h3_index === h3Index)
    return feature?.properties ?? null
  }

  function analyzeHexVibes(hex: H3CellSummary): VibeAnalysis {
    const metrics = buildHexMetricVector(hex)
    const scores = activeVibes().map((definition) => {
      const contributions = vibeMetricMeta
        .filter(({ key }) => Math.abs(definition.weights[key]) > 0)
        .map(({ key, label }) => {
          const raw = metrics[key]
          const weight = definition.weights[key]
          const affinity = weight >= 0 ? raw : 100 - raw

          return {
            key,
            label,
            raw,
            weight,
            affinity,
          }
        })

      const totalWeight = contributions.reduce((total, item) => total + Math.abs(item.weight), 0)
      const weightedScore =
        totalWeight === 0
          ? 0
          : contributions.reduce((total, item) => total + item.affinity * Math.abs(item.weight), 0) /
            totalWeight

      return {
        id: definition.id,
        label: definition.label,
        color: definition.color,
        formula: definition.formula,
        isCustom: definition.isCustom,
        score: weightedScore,
        contributions,
      }
    })

    const dominant = [...scores]
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))[0]

    const color = mixVibeColors(scores)
    const opacity = 0.2 + ((dominant?.score ?? 0) / 100) * 0.24

    return {
      scores,
      dominant: dominant ? { label: dominant.label, score: dominant.score } : null,
      color,
      opacity: clamp(opacity, 0.2, 0.44),
    }
  }

  function buildHexMetricVector(hex: H3CellSummary): Record<VibeMetricKey, number> {
    const rackDensityMax = Math.max(1, ...(rawHexes?.features.map((feature) => feature.properties.rack_count) ?? [1]))
    const infrastructureDensityMax = Math.max(
      1,
      ...(rawHexes?.features.map((feature) => feature.properties.infrastructure_count) ?? [1]),
    )

    const rackDensity = clamp(hex.rack_density_score ?? (hex.rack_count / rackDensityMax) * 100, 0, 100)
    const infrastructureDensity = clamp(
      hex.infrastructure_density_score ?? (hex.infrastructure_count / infrastructureDensityMax) * 100,
      0,
      100,
    )
    const airProxy = clamp(
      hex.air_proxy_score ?? hex.mean_greenery_score * 0.55 + hex.mean_noise_score * 0.45,
      0,
      100,
    )

    return {
      air_proxy: airProxy,
      demand: clamp(hex.demand_score, 0, 100),
      greenery: clamp(hex.mean_greenery_score, 0, 100),
      infrastructure_access: clamp(hex.mean_infrastructure_score, 0, 100),
      infrastructure_density: infrastructureDensity,
      network: clamp(hex.network_score, 0, 100),
      quality: clamp(hex.quality_score, 0, 100),
      quietness: clamp(hex.mean_noise_score, 0, 100),
      rack_access: clamp(hex.mean_rack_score, 0, 100),
      rack_density: rackDensity,
    }
  }

  function catalogVibes() {
    return catalogVibeList
  }

  function activeVibes() {
    return activeVibeList
  }

  function isVibeEnabled(vibeId: string) {
    return enabledVibeIds.includes(vibeId)
  }

  function toggleVibe(vibeId: string) {
    enabledVibeIds = isVibeEnabled(vibeId)
      ? enabledVibeIds.filter((id) => id !== vibeId)
      : [...enabledVibeIds, vibeId]
    rerouteIfReady()
  }

  function isRouteVibeEnabled(vibeId: string) {
    return isVibeEnabled(vibeId)
  }

  function rerouteIfReady() {
    if (routeStart && routeEnd && routingMode === 'idle') {
      computeRoute()
    }
  }

  function activeRouteVibes() {
    return activeVibes()
  }

  function addRouteVibe(vibeId: string) {
    if (isVibeEnabled(vibeId)) {
      routeVibeSearch = ''
      return
    }

    enabledVibeIds = [...enabledVibeIds, vibeId]
    routeVibeSearch = ''
    rerouteIfReady()
  }

  function removeRouteVibe(vibeId: string) {
    if (!isVibeEnabled(vibeId)) {
      return
    }

    enabledVibeIds = enabledVibeIds.filter((id) => id !== vibeId)
    rerouteIfReady()
  }

  function clearAllVibes() {
    if (enabledVibeIds.length === 0) {
      return
    }

    enabledVibeIds = []
    rerouteIfReady()
  }

  function applyVibeSelection(vibeIds: string[]) {
    const catalogIds = new Set(catalogVibes().map((vibe) => vibe.id))
    const nextIds = vibeIds.filter((vibeId, index) => catalogIds.has(vibeId) && vibeIds.indexOf(vibeId) === index)

    enabledVibeIds = nextIds
    routeVibeSearch = ''
    rerouteIfReady()
  }

  function normalizeSearchValue(value: string) {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
  }

  function vibeKindLabel(vibe: VibeDefinition) {
    if (vibe.isCustom) {
      return 'Wlasny vibe'
    }

    if (vibe.id.startsWith('pure_')) {
      return 'Czysta metryka'
    }

    return 'Bazowy vibe'
  }

  function availableRouteVibes() {
    return availableRouteVibeList
  }

  function corridorScenarioList() {
    if (!summary) {
      return []
    }

    if (summary.corridor_recommendations.scenarios?.length) {
      return summary.corridor_recommendations.scenarios
    }

    return [
      {
        scenario: summary.corridor_recommendations.scenario,
        hotspots: summary.corridor_recommendations.hotspots,
        recommended: summary.corridor_recommendations.recommended,
      },
    ]
  }

  function selectedCorridorScenario() {
    const scenarios = corridorScenarioList()
    return (
      scenarios.find((item) => item.scenario.id === selectedCorridorScenarioId) ??
      scenarios[0] ??
      null
    )
  }

  const vibeMetricDocCodeByKey: Record<VibeMetricKey, string> = {
    air_proxy: 'air_proxy_score',
    demand: 'demand_score',
    greenery: 'mean_greenery_score',
    infrastructure_access: 'mean_infrastructure_score',
    infrastructure_density: 'infrastructure_density_score',
    network: 'network_score',
    quality: 'quality_score',
    quietness: 'mean_noise_score',
    rack_access: 'mean_rack_score',
    rack_density: 'rack_density_score',
  }

  function vibeMetricByKey(key: VibeMetricKey) {
    return vibeMetricMeta.find((metric) => metric.key === key) ?? null
  }

  function scenarioDisplayLabel(
    scenario: { label: string; metric_key?: string | null },
  ) {
    if (!scenario.metric_key) {
      return 'Zbalansowany wynik obszaru H3'
    }

    const metric = vibeMetricByKey(scenario.metric_key as VibeMetricKey)
    return metric ? `${metric.label} 100%` : scenario.label
  }

  function scenarioDisplayNote(
    scenario: { label: string; metric_key?: string | null },
    currentSummary: Summary,
  ) {
    if (!scenario.metric_key) {
      return `Koszt trasy liczony z wyniku obszaru H3: ${currentSummary.explainability.h3_indexing.scenario.cell_score_formula}`
    }

    const metric = vibeMetricByKey(scenario.metric_key as VibeMetricKey)
    const doc = dataDocByCode(currentSummary, vibeMetricDocCodeByKey[scenario.metric_key as VibeMetricKey])

    if (!metric) {
      return 'Czysty scenariusz liczony tylko z jednej metryki H3.'
    }

    return `Trasa optymalizowana tylko pod metrykę „${metric.label}”. ${doc?.formula ?? ''}`
  }

  function routeVibeAlphaValue(level: number) {
    return Math.max(0, level - 1)
  }

  function routeAlphaLabel(level: number) {
    const alpha = routeVibeAlphaValue(level)
    if (alpha <= 0) {
      return 'Najkrótsza'
    }
    if (alpha <= 1) {
      return `Lekki vibe (${level}/10)`
    }
    if (alpha < 2) {
      return `Silny vibe (${level}/10)`
    }
    return `Vibe-first (${level}/10)`
  }

  function routeAlphaDescription(level: number) {
    const alpha = routeVibeAlphaValue(level)
    if (alpha <= 0) {
      return 'Liczy się tylko długość odcinka. Vibe nie wpływa na routing.'
    }
    if (alpha <= 0.5) {
      return 'Lekki wpływ vibe. Trasa dalej mocno preferuje krótszy dystans.'
    }
    if (alpha <= 1) {
      return 'Zbalansowany kompromis między dystansem a vibe.'
    }
    if (alpha <= 2) {
      return 'Silny wpływ vibe. Trasa może być wyraźnie dłuższa, jeśli obszary mają lepszy vibe.'
    }
    return 'Tryb vibe-first. Algorytm może wybrać nawet dużo dłuższą trasę, jeśli vibe jest istotnie lepszy.'
  }

  function routeMultiplierForVibe(level: number, vibeScore: number) {
    const alpha = routeVibeAlphaValue(level)
    if (alpha <= 0) {
      return 1
    }

    const deficit = Math.max(0, Math.min(100, 100 - vibeScore)) / 100
    return 1 + alpha * deficit ** 1.5
  }

  function dataDocByCode(currentSummary: Summary, code: string | undefined) {
    if (!code) {
      return null
    }

    for (const section of dataDocumentationSections(currentSummary)) {
      const found = section.items.find((item) => item.code === code)
      if (found) {
        return found
      }
    }

    return null
  }

  function selectCorridorScenario(scenarioId: string) {
    const scenarios = corridorScenarioList()
    const nextScenario =
      scenarios.find((item) => item.scenario.id === scenarioId) ?? scenarios[0] ?? null

    selectedCorridorScenarioId = nextScenario?.scenario.id ?? null
    selectedCorridor =
      nextScenario?.recommended.find(
        (corridor) =>
          corridor.corridor_id === selectedCorridor?.corridor_id &&
          corridor.scenario_id === selectedCorridor?.scenario_id,
      ) ??
      nextScenario?.recommended[0] ??
      null
  }

  function mixVibeColors(scores: VibeAnalysis['scores']) {
    const total = scores.reduce((sum, item) => sum + item.score, 0)
    if (total <= 0) {
      return '#94a3b8'
    }

    const mixed = scores.reduce(
      (accumulator, item) => {
        const rgb = hexToRgb(item.color)
        const weight = item.score / total
        return {
          red: accumulator.red + rgb.red * weight,
          green: accumulator.green + rgb.green * weight,
          blue: accumulator.blue + rgb.blue * weight,
        }
      },
      { red: 0, green: 0, blue: 0 },
    )

    return rgbToHex(mixed.red, mixed.green, mixed.blue)
  }

  function hexToRgb(color: string) {
    const normalized = color.replace('#', '')
    const value = normalized.length === 3 ? normalized.split('').map((part) => `${part}${part}`).join('') : normalized

    return {
      red: Number.parseInt(value.slice(0, 2), 16),
      green: Number.parseInt(value.slice(2, 4), 16),
      blue: Number.parseInt(value.slice(4, 6), 16),
    }
  }

  function rgbToHex(red: number, green: number, blue: number) {
    return `#${[red, green, blue]
      .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
      .join('')}`
  }

  function darkenHexColor(color: string, amount: number) {
    const rgb = hexToRgb(color)

    return rgbToHex(rgb.red * (1 - amount), rgb.green * (1 - amount), rgb.blue * (1 - amount))
  }

  function createEmptyVibeWeights(): Record<VibeMetricKey, number> {
    return {
      air_proxy: 0,
      demand: 0,
      greenery: 0,
      infrastructure_access: 0,
      infrastructure_density: 0,
      network: 0,
      quality: 0,
      quietness: 0,
      rack_access: 0,
      rack_density: 0,
    }
  }

  function resetCustomVibeDraft() {
    customVibeLabel = 'Wlasny vibe'
    customVibeColor = '#2563eb'
    customVibeWeights = createEmptyVibeWeights()
  }

  function addCustomVibe() {
    const totalWeight = Object.values(customVibeWeights).reduce(
      (sum, value) => sum + Math.abs(value),
      0,
    )

    if (totalWeight === 0) {
      return
    }

    const nextIndex = customVibes.length + 1
    customVibes = [
      ...customVibes,
      {
        id: `custom_${nextIndex}`,
        label: customVibeLabel.trim() || `Wlasny vibe ${nextIndex}`,
        color: customVibeColor,
        isCustom: true,
        formula:
          'score = srednia wazona wybranych metryk; ujemna waga odwraca metryke do 100 - metric',
        weights: { ...customVibeWeights },
      },
    ]
    enabledVibeIds = [...enabledVibeIds, `custom_${nextIndex}`]
    rerouteIfReady()

    resetCustomVibeDraft()
  }

  function removeCustomVibe(vibeId: string) {
    const wasEnabled = isVibeEnabled(vibeId)
    customVibes = customVibes.filter((vibe) => vibe.id !== vibeId)
    enabledVibeIds = enabledVibeIds.filter((id) => id !== vibeId)
    if (wasEnabled) {
      rerouteIfReady()
    }
  }

  function syncCorridorVisibility() {
    if (!map || !isMapReady) {
      return
    }

    const scenarioFilter: ['==', string, string] | null = selectedCorridorScenarioId
      ? ['==', 'scenario_id', selectedCorridorScenarioId]
      : null

    map.setFilter('corridors-base', scenarioFilter)
    map.setFilter('corridors-fill', scenarioFilter)
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
      'all',
      ['==', ['get', 'scenario_id'], selectedCorridor?.scenario_id ?? '__brak__'],
      ['==', ['get', 'corridor_id'], selectedCorridor?.corridor_id ?? -1],
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

  // ---------------------------------------------------------------------------
  // Routing A→B
  // ---------------------------------------------------------------------------

  async function buildGraphAsync(
    segments: SegmentFeatureCollection,
    hexes: HexFeatureCollection,
  ) {
    isGraphBuilding = true
    try {
      await preloadH3()
      const cells = hexes.features.map((f) => f.properties)
      routingGraph = buildRoutingGraph(segments, cells)
    } catch (err) {
      console.error('Failed to build routing graph:', err)
    } finally {
      isGraphBuilding = false
    }
  }

  function startRouting() {
    routingMode = 'selectStart'
    routeStart = null
    routeEnd = null
    routeResult = null
    routeError = null
  }

  function cancelRouting() {
    routingMode = 'idle'
    routeStart = null
    routeEnd = null
    routeResult = null
    routeError = null
    syncRouteDisplay()
  }

  function handleRoutingClick(lngLat: { lng: number; lat: number }) {
    if (!routingGraph) return false
    if (routingMode === 'idle') return false

    const coordinate: [number, number] = [lngLat.lng, lngLat.lat]
    const nearest = findNearestNode(coordinate, routingGraph)

    if (!nearest) {
      routeError = 'Nie znaleziono ścieżki rowerowej w pobliżu (max 800 m).'
      return true
    }

    if (routingMode === 'selectStart') {
      routeStart = nearest
      routeEnd = null
      routeResult = null
      routeError = null
      routingMode = 'selectEnd'
      syncRouteDisplay()
      return true
    }

    if (routingMode === 'selectEnd') {
      routeEnd = nearest
      routeError = null
      routingMode = 'idle'
      computeRoute()
      return true
    }

    return false
  }

  function computeRoute() {
    if (!routingGraph || !routeStart || !routeEnd || !rawHexes) {
      return
    }

    // Check if both nodes are in the same connected component
    const startComponent = routingGraph.node_component_id_by_node_id[routeStart.node_id]
    const endComponent = routingGraph.node_component_id_by_node_id[routeEnd.node_id]

    if (startComponent !== endComponent) {
      routeError = 'Punkty A i B są w rozłącznych częściach sieci rowerowej. Nie ma trasy.'
      routeResult = null
      syncRouteDisplay()
      return
    }

    const vibes = activeRouteVibes()
    const vibeWeightsArray: VibeWeights[] = vibes.map((v) => ({ weights: v.weights }))
    const cells = rawHexes.features.map((f) => f.properties)
    const alpha = routeVibeAlphaValue(routeVibeLevel)

    console.log(`[route] Computing: alpha=${alpha}, activeRouteVibes=${vibes.length} (${vibes.map(v => v.id).join(', ')})`)
    console.log(`[route] Edges with H3: ${routingGraph.edges.filter(e => e.edge_h3_index !== null).length}/${routingGraph.edges.length}`)

    const edgeCosts = buildVibeEdgeCosts(
      routingGraph,
      cells,
      vibeWeightsArray,
      alpha,
    )

    // Debug: sample edge costs
    const baseCosts = routingGraph.edges.map(e => e.length_m)
    let diffCount = 0
    for (let i = 0; i < edgeCosts.length; i++) {
      if (Math.abs(edgeCosts[i] - baseCosts[i]) > 0.01) diffCount++
    }
    console.log(`[route] Edge costs differing from pure distance: ${diffCount}/${edgeCosts.length}`)

    const result = astar(routingGraph, routeStart.node_id, routeEnd.node_id, edgeCosts)

    if (!result) {
      routeError = 'Nie znaleziono trasy między wybranymi punktami.'
      routeResult = null
    } else {
      routeResult = result
      routeError = null
    }

    syncRouteDisplay()

    // Fit map to route bounds
    if (routeResult && map && routeResult.coordinates.length > 1) {
      const lngs = routeResult.coordinates.map((c) => c[0])
      const lats = routeResult.coordinates.map((c) => c[1])
      map.fitBounds(
        [
          [Math.min(...lngs) - 0.005, Math.min(...lats) - 0.003],
          [Math.max(...lngs) + 0.005, Math.max(...lats) + 0.003],
        ],
        { duration: 600, padding: 60 },
      )
    }
  }

  function syncRouteDisplay() {
    if (!map || !isMapReady) return

    const routeSource = map.getSource('route') as GeoJSONSource | undefined
    const markersSource = map.getSource('route-markers') as GeoJSONSource | undefined

    if (routeSource) {
      routeSource.setData(
        routeResult && routeResult.coordinates.length > 1
          ? {
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: routeResult.coordinates,
                  },
                  properties: {
                    total_length_m: routeResult.total_length_m,
                    mean_score: routeResult.mean_score,
                  },
                },
              ],
            }
          : { type: 'FeatureCollection', features: [] },
      )
    }

    if (markersSource) {
      const features: Array<{
        type: 'Feature'
        geometry: { type: 'Point'; coordinates: [number, number] }
        properties: { kind: string; label: string }
      }> = []

      if (routeStart) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: routeStart.coordinate },
          properties: { kind: 'start', label: 'A' },
        })
      }
      if (routeEnd) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: routeEnd.coordinate },
          properties: { kind: 'end', label: 'B' },
        })
      }

      markersSource.setData({ type: 'FeatureCollection', features })
    }

    setLayerVisibility('route-casing', showRoute && !!routeResult)
    setLayerVisibility('route-line', showRoute && !!routeResult)
    setLayerVisibility('route-markers', showRoute && (!!routeStart || !!routeEnd))
    setLayerVisibility('route-markers-label', showRoute && (!!routeStart || !!routeEnd))
  }

  // ---------------------------------------------------------------------------
  // Isochrones
  // ---------------------------------------------------------------------------

  function startIsochrone() {
    isochroneMode = true
    isochroneResult = null
  }

  function cancelIsochrone() {
    isochroneMode = false
    isochroneResult = null
    syncIsochroneDisplay()
  }

  function handleIsochroneClick(lngLat: { lng: number; lat: number }) {
    if (!routingGraph || !isochroneMode) return false

    const coordinate: [number, number] = [lngLat.lng, lngLat.lat]
    const nearest = findNearestNode(coordinate, routingGraph)
    if (!nearest) return true

    isochroneMode = false

    // Bands: 1km, 2.5km, 5km, 10km (in meters)
    const result = computeIsochrone(routingGraph, nearest.node_id, [
      { cost_limit: 1000, label: '1 km' },
      { cost_limit: 2500, label: '2.5 km' },
      { cost_limit: 5000, label: '5 km' },
      { cost_limit: 10000, label: '10 km' },
    ])

    isochroneResult = result
    syncIsochroneDisplay()
    return true
  }

  function syncIsochroneDisplay() {
    if (!map || !isMapReady) return

    const source = map.getSource('isochrone') as GeoJSONSource | undefined
    if (!source) return

    if (!isochroneResult || !showIsochrone) {
      source.setData({ type: 'FeatureCollection', features: [] })
      setLayerVisibility('isochrone-fill', false)
      setLayerVisibility('isochrone-outline', false)
      return
    }

    const bandColors = ['#a78bfa', '#8b5cf6', '#6d28d9', '#4c1d95']

    source.setData({
      type: 'FeatureCollection',
      features: isochroneResult.bands.map((band, i) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [band.coordinates],
        },
        properties: {
          label: band.label,
          cost_limit: band.cost_limit,
          color: bandColors[i] ?? '#4c1d95',
        },
      })),
    })

    setLayerVisibility('isochrone-fill', true)
    setLayerVisibility('isochrone-outline', true)
  }

  // ---------------------------------------------------------------------------
  // Centrality
  // ---------------------------------------------------------------------------

  async function runCentralityAnalysis() {
    if (!routingGraph || isCentralityComputing) return

    isCentralityComputing = true
    // Run in a microtask to not block UI
    await new Promise((resolve) => setTimeout(resolve, 50))

    centralityResult = computeCentrality(routingGraph, 150)
    isCentralityComputing = false
    showBetweenness = true
    syncCentralityDisplay()
  }

  function syncCentralityDisplay() {
    if (!map || !isMapReady) return

    const source = map.getSource('centrality') as GeoJSONSource | undefined
    if (!source) return

    if (!centralityResult || !showBetweenness || !routingGraph) {
      source.setData({ type: 'FeatureCollection', features: [] })
      setLayerVisibility('centrality-layer', false)
      return
    }

    const maxB = centralityResult.max_betweenness
    const features = routingGraph.edges
      .filter((edge) => edge.segment_id !== -1) // skip virtual bridges
      .map((edge, i) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: edge.coordinates,
        },
        properties: {
          betweenness: centralityResult!.betweenness_by_edge[i],
          normalized: maxB > 0 ? centralityResult!.betweenness_by_edge[i] / maxB : 0,
          segment_id: edge.segment_id,
        },
      }))
      .filter((f) => f.properties.normalized > 0.01) // hide near-zero

    source.setData({ type: 'FeatureCollection', features })
    setLayerVisibility('centrality-layer', true)
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
    selectedHex = getHexByIndex(hex.h3_index) ?? hex

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

  function toggleAllPointMarkers() {
    const nextVisibility = !hasVisiblePointMarkers
    showRacks = nextVisibility
    showInfrastructure = nextVisibility
    showHotspots = nextVisibility
  }

  function buildPreviewBounds(bounds: [number, number, number, number] | null): MapBoundsLike | undefined {
    if (!bounds) {
      return undefined
    }

    const [west, south, east, north] = bounds
    const lonMargin = Math.max((east - west) * KRAKOW_PREVIEW_MARGIN_RATIO, 0.01)
    const latMargin = Math.max((north - south) * KRAKOW_PREVIEW_MARGIN_RATIO, 0.006)

    return [
      [west - lonMargin, south - latMargin],
      [east + lonMargin, north + latMargin],
    ]
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
      corridor_key: toNullableString(properties.corridor_key) ?? undefined,
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
      route_metric_key: toNullableString(properties.route_metric_key),
      route_metric_label: toNullableString(properties.route_metric_label),
      scenario_id: toNullableString(properties.scenario_id),
      scenario_label: toNullableString(properties.scenario_label),
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
      air_proxy_score: toNumber(properties?.air_proxy_score),
      center: parseCoordinate(properties?.center) ?? KRAKOW_CENTER,
      cell_id: toNullableString(properties?.cell_id) ?? 'brak',
      component_id: toNullableNumber(properties?.component_id),
      density_score: toNumber(properties?.density_score),
      graph_node_id: toNumber(properties?.graph_node_id),
      h3_index: toNullableString(properties?.h3_index) ?? 'brak',
      h3_resolution: toNumber(properties?.h3_resolution),
      hex_score: toNumber(properties?.hex_score),
      hub_id: toNumber(properties?.hub_id),
      infrastructure_count: toNumber(properties?.infrastructure_count),
      infrastructure_density_score: toNumber(properties?.infrastructure_density_score),
      label: toNullableString(properties?.label) ?? 'brak',
      mean_segment_score: toNumber(properties?.mean_segment_score),
      network_score: toNumber(properties?.network_score),
      point_count: toNumber(properties?.point_count),
      quality_score: toNumber(properties?.quality_score),
      rack_count: toNumber(properties?.rack_count),
      rack_density_score: toNumber(properties?.rack_density_score),
      route_metric_key: toNullableString(properties?.route_metric_key),
      route_metric_label: toNullableString(properties?.route_metric_label),
      route_score: toNullableNumber(properties?.route_score) ?? 0,
      scenario_id: toNullableString(properties?.scenario_id),
      scenario_label: toNullableString(properties?.scenario_label),
      snap_distance_m: toNumber(properties?.snap_distance_m),
      demand_score: toNumber(properties?.demand_score),
      total_weight: toNumber(properties?.total_weight),
    }
  }

  function toH3CellSummary(feature: MapGeoJSONFeature): H3CellSummary {
    const properties = feature.properties ?? {}

    return {
      air_proxy_score: toNumber(properties.air_proxy_score),
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
      mean_greenery_score: toNumber(properties.mean_greenery_score),
      mean_infrastructure_score: toNumber(properties.mean_infrastructure_score),
      mean_nearest_infra_m: toNullableNumber(properties.mean_nearest_infra_m),
      mean_nearest_rack_m: toNullableNumber(properties.mean_nearest_rack_m),
      mean_noise_score: toNumber(properties.mean_noise_score),
      mean_rack_score: toNumber(properties.mean_rack_score),
      mean_segment_score: toNumber(properties.mean_segment_score),
      network_score: toNumber(properties.network_score),
      point_count: toNumber(properties.point_count),
      quality_score: toNumber(properties.quality_score),
      rack_count: toNumber(properties.rack_count),
      rack_density_score: toNumber(properties.rack_density_score),
      segment_sample_count: toNumber(properties.segment_sample_count),
      infrastructure_density_score: toNumber(properties.infrastructure_density_score),
      total_segment_length_km: toNumber(properties.total_segment_length_km),
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

  function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }

  function connectorEvidenceRows(connector: RecommendedConnector) {
    const connectorMeta = summary?.explainability.connector_optimization
    if (!connectorMeta) {
      return []
    }

    const { scenario } = connectorMeta
    const withinLengthWindow =
      connector.length_m >= scenario.min_connector_length_meters &&
      connector.length_m <= scenario.max_connector_length_meters

    const crossingDetail =
      connector.network_crossings_count === 0
        ? 'Łącznik nie przecina istniejącej sieci poza końcami, więc nie dostaje kary za przecięcia.'
        : `Łącznik przecina istniejącą sieć ${formatCount(connector.network_crossings_count)} razy poza strefą końców, więc dostaje karę ${formatPoints(connector.crossing_penalty_points)}.`

    return [
      {
        title: 'Łączy dwa rozłączne komponenty sieci',
        detail: `${connector.source_component_label} i ${connector.target_component_label} to dwa różne komponenty grafu zbudowanego z istniejących ciągów rowerowych. Ten kandydat ma domknąć lukę między nimi, a nie powielać już istniejący odcinek.`,
      },
      {
        title: withinLengthWindow ? 'Spełnia warunek długości' : 'Nie spełnia warunku długości',
        detail: `Ma ${formatDistance(connector.length_m)} i ${withinLengthWindow ? 'mieści się' : 'nie mieści się'} w dopuszczalnym przedziale ${scenario.min_connector_length_meters}-${scenario.max_connector_length_meters} m.`,
      },
      {
        title: 'Ma policzony zysk popytu',
        detail: `Komponent docelowy ma wagę popytu ${formatFixed(connector.target_component_demand_weight, 1)}, co daje ${formatPoints(connector.demand_gain_points)} w priorytecie.`,
      },
      {
        title: 'Ma policzony zysk sieci',
        detail: `Komponent docelowy ma ${formatCount(connector.target_component_nodes)} węzłów i ${formatCount(connector.target_component_edges)} krawędzi, co daje ${formatPoints(connector.network_gain_points)} za poprawę spójności sieci.`,
      },
      {
        title: 'Warunki środowiskowe są mierzone, nie zgadywane',
        detail: `Na próbkach łącznika policzono zieleń ${formatPercent(connector.greenery_ratio)} i hałas ${formatNoise(connector.max_noise_db)}. To składa się na ${formatPoints(connector.environment_points)} punktów środowiskowych.`,
      },
      {
        title: 'Kara za przecięcia jest jawna',
        detail: crossingDetail,
      },
      {
        title: 'Priorytet wynika z jawnej formuły',
        detail: `Priorytet ${formatScore(connector.priority_score)} = popyt ${formatPoints(connector.demand_gain_points)} + sieć ${formatPoints(connector.network_gain_points)} + dystans ${formatPoints(connector.distance_points)} + środowisko ${formatPoints(connector.environment_points)} - przecięcia ${formatPoints(connector.crossing_penalty_points)}.`,
      },
    ]
  }

  function mapLegendDocs(currentSummary: Summary): LegendDoc[] {
    const currentScenario =
      selectedCorridorScenario()?.scenario ?? currentSummary.corridor_recommendations.scenario

    return [
      {
        label: '80-100 / 65-79 / 50-64 / 0-49',
        kind: 'Progi koloru segmentów',
        source: 'segments.geojson -> properties.score',
        formula:
          'najpierw liczony jest score segmentu = zieleń 35% + hałas 30% + stojaki 20% + infrastruktura 15%, a dopiero potem ten wynik wpada do progu koloru: 0-49, 50-64, 65-79, 80-100',
        meaning:
          'To nie są osobne punkty ani warstwy i nie są liczone osobno. To tylko 4 przedziały koloru końcowego score segmentu. Dotyczą wyłącznie warstwy segmentów i listy Top 20.',
      },
      {
        label: 'Kraków / OSM',
        kind: 'Podkład mapy',
        source: 'OpenStreetMap raster',
        formula: 'Brak obliczeń. Podkład nie wchodzi do score ani do routingu.',
        meaning:
          'Warstwa orientacyjna pokazująca ulice i kontekst miasta. Jest tylko tłem przestrzennym dla danych z challenge.',
      },
      {
        label: 'Siatka H3 / vibe',
        kind: 'Warstwa analityczna',
        source: 'hexes.geojson -> metryki H3 + klientowy mix vibe',
        formula: `hex_score: ${currentSummary.explainability.h3_indexing.scenario.cell_score_formula}; kolor: miks RGB aktywnych vibe`,
        meaning:
          'To są poligony heksów H3. Geometria heksów pochodzi z preprocessingu. Liczbowy hex_score jest osobną metryką 0-100, ale kolor heksa na mapie pochodzi z miksu vibe, a nie z samego hex_score.',
      },
      {
        label: 'Hub H3',
        kind: 'Warstwa węzłów trasowania',
        source: 'hotspots.geojson -> top komórki H3 z popytem i snapem do grafu',
        formula: `wybór hubów = top komórki H3 z punktami, min odstęp ${currentSummary.explainability.h3_indexing.scenario.min_hub_separation_meters} m, snap do grafu <= ${currentSummary.explainability.h3_indexing.scenario.max_hub_snap_distance_meters} m; geometria punktu = środek wybranej komórki H3`,
        meaning:
          'To nie jest cała siatka H3. To tylko wybrane komórki H3 pokazane jako punkty w ich środku, żeby routing miał jeden reprezentatywny start/koniec komórki i żeby mapa była czytelna. Potem ten punkt jest snapowany do najbliższego węzła grafu.',
      },
      {
        label: 'Rekomendowany korytarz',
        kind: 'Warstwa routingu',
        source: 'corridors.geojson -> wynik Dijkstry po grafie segmentów',
        formula: currentScenario.edge_cost_formula,
        meaning:
          'To policzona trasa po istniejącej sieci rowerowej. Nie jest prostą linią między hubami, tylko najtańszą ścieżką według wybranego scenariusza.',
      },
      {
        label: 'Nowy łącznik',
        kind: 'Warstwa kandydatów planistycznych',
        source: 'connectors.geojson -> kandydaty między rozłącznymi komponentami grafu',
        formula: currentSummary.explainability.connector_optimization.scenario.priority_formula,
        meaning:
          'To kandydat nowego brakującego odcinka między komponentami sieci, a nie istniejący segment z danych wejściowych.',
      },
    ]
  }

  function dataDocumentationSections(currentSummary: Summary): DataDocSection[] {
    const scoring = currentSummary.explainability.scoring
    const references = scoring.references
    const h3 = currentSummary.explainability.h3_indexing.scenario
    const currentScenario =
      selectedCorridorScenario()?.scenario ?? currentSummary.corridor_recommendations.scenario
    const connector = currentSummary.explainability.connector_optimization

    return [
      {
        title: 'Operatory przeliczeń',
        intro:
          'To są podstawowe operatory, z których budowane są wszystkie score 0-100 w tym projekcie.',
        items: [
          {
            code: 'normalize',
            label: 'Normalizacja do 0-100',
            valueType: 'Operator znormalizowany',
            source: 'Wartość policzona w tej paczce danych + maksimum z tej samej paczki',
            formula: 'normalize(value, max) = clamp((value / max) * 100, 0, 100)',
            usage:
              'Używane do demand_score, network_score, rack_density_score i infrastructure_density_score.',
            note:
              'To normalizacja względna wewnątrz tej paczki danych, nie uniwersalna skala miejska.',
          },
          {
            code: 'scaleDescending',
            label: 'Skala „mniej = lepiej”',
            valueType: 'Operator znormalizowany',
            source: 'Surowa wartość + jawny zakres best/worst',
            formula:
              'scaleDescending(value, best, worst) = clamp(((worst - value) / (worst - best)) * 100, 0, 100)',
            usage:
              'Używane do noise_score, rack_score, infrastructure_score i distance_points łącznika.',
            note:
              'Jeśli wartość jest mniejsza, score rośnie. Jeśli większa, score maleje do 0.',
          },
          {
            code: 'mean',
            label: 'Średnia arytmetyczna',
            valueType: 'Operator agregujący',
            source: 'Lista wartości z próbek lub odcinków',
            formula: 'mean(values) = suma(values) / liczba(values)',
            usage:
              'Używane do quality_score H3, mean_*_score w H3, mean_segment_score i mean_h3_score korytarza.',
          },
          {
            code: 'sample_step_meters',
            label: 'Krok próbkowania geometrii',
            valueType: 'Parametr preprocessingowy',
            source: 'Konfiguracja preprocessingu Node',
            formula: `sample_step = ${scoring.sample_step_meters} m`,
            usage:
              'Co ten krok pobierane są próbki na segmentach i łącznikach do zieleni, hałasu i agregacji H3.',
          },
        ],
      },
      {
        title: 'Segmenty',
        intro:
          'To metryki liczone dla pojedynczego istniejącego odcinka ścieżki rowerowej po normalizacji wszystkich warstw do WGS84.',
        items: [
          {
            code: 'score',
            label: 'Score segmentu',
            valueType: 'Finalny score 0-100',
            source:
              'Ciągi rowerowe + zieleń BDOT10k + hałas + stojaki ZTP + infrastruktura rowerowa ZTP',
            formula: scoring.formula,
            usage:
              'Ranking segmentów, Top 20, quality_score w H3 i średnie jakości na korytarzach.',
          },
          {
            code: 'greenery_ratio',
            label: 'Pokrycie zieleni',
            valueType: 'Surowa proporcja 0-1',
            source: 'Próbki segmentu + poligony zieleni BDOT10k',
            formula: 'greenery_ratio = greenery_hits / sample_count',
            usage: 'Z niego liczone są greenery_score i część score segmentu.',
            note:
              `Próbkowanie odbywa się co ${scoring.sample_step_meters} m, a nie przez pełne przecięcie bufora powierzchniowego.`,
          },
          {
            code: 'greenery_score',
            label: 'Score zieleni',
            valueType: 'Subscore 0-100',
            source: 'greenery_ratio',
            formula: 'greenery_score = greenery_ratio * 100',
            usage: '35% finalnego score segmentu i później mean_greenery_score w H3.',
          },
          {
            code: 'max_noise_db',
            label: 'Maksymalny hałas',
            valueType: 'Surowa wartość dB',
            source: 'Próbki segmentu + poligony hałasu',
            formula: 'max_noise_db = max(noise_value dla próbek segmentu)',
            usage: 'Z niego liczone są noise_score i prezentacja hałasu segmentu.',
          },
          {
            code: 'noise_score',
            label: 'Score hałasu',
            valueType: 'Subscore 0-100',
            source: 'max_noise_db + zakres referencyjny',
            formula: `noise_score = brak ? ${references.noiseDb.missingScore} : scaleDescending(max_noise_db, ${references.noiseDb.best}, ${references.noiseDb.worst})`,
            usage: '30% finalnego score segmentu i później mean_noise_score w H3.',
          },
          {
            code: 'nearest_rack_m',
            label: 'Najbliższy stojak',
            valueType: 'Surowy dystans w metrach',
            source: 'Geometria segmentu + punkty stojaków ZTP',
            formula: 'nearest_rack_m = min(distance(segment, rack))',
            usage: 'Z niego liczone są rack_score i karta segmentu.',
          },
          {
            code: 'rack_score',
            label: 'Score dostępu do stojaków',
            valueType: 'Subscore 0-100',
            source: 'nearest_rack_m + zakres referencyjny',
            formula: `rack_score = brak ? ${references.rackDistanceM.missingScore} : scaleDescending(nearest_rack_m, ${references.rackDistanceM.best}, ${references.rackDistanceM.worst})`,
            usage: '20% finalnego score segmentu i później mean_rack_score w H3.',
          },
          {
            code: 'nearest_infra_m',
            label: 'Najbliższy punkt infrastruktury',
            valueType: 'Surowy dystans w metrach',
            source: 'Geometria segmentu + punkty infrastruktury rowerowej ZTP',
            formula: 'nearest_infra_m = min(distance(segment, infrastruktura_point))',
            usage: 'Z niego liczone są infrastructure_score i karta segmentu.',
          },
          {
            code: 'infrastructure_score',
            label: 'Score dostępu do infrastruktury',
            valueType: 'Subscore 0-100',
            source: 'nearest_infra_m + zakres referencyjny',
            formula: `infrastructure_score = brak ? ${references.infrastructureDistanceM.missingScore} : scaleDescending(nearest_infra_m, ${references.infrastructureDistanceM.best}, ${references.infrastructureDistanceM.worst})`,
            usage: '15% finalnego score segmentu i później mean_infrastructure_score w H3.',
          },
        ],
      },
      {
        title: 'H3 i agregacja komórek',
        intro:
          'To metryki agregowane z punktów i próbek segmentów wpadających do jednej aktywnej komórki H3.',
        items: [
          {
            code: 'point_count',
            label: 'Liczba punktów',
            valueType: 'Surowa liczba obiektów',
            source: 'Stojaki ZTP + punkty infrastruktury ZTP',
            formula: 'point_count = rack_count + infrastructure_count',
            usage: 'Opisuje, ile obiektów popytu wpada do heksa.',
          },
          {
            code: 'demand_weight',
            label: 'Ważony popyt',
            valueType: 'Surowa wartość ważona',
            source: 'Punkty popytu w heksie',
            formula: 'demand_weight = rack_count*1 + infrastructure_count*2.5',
            usage: 'Wejście do demand_score.',
          },
          {
            code: 'demand_score',
            label: 'Score popytu',
            valueType: 'Znormalizowany score 0-100',
            source: 'demand_weight',
            formula: h3.demand_score_formula,
            usage: '45% balanced hex_score i jeden z pure route scenarios.',
          },
          {
            code: 'segment_sample_count',
            label: 'Liczba próbek segmentów',
            valueType: 'Surowa liczba próbek',
            source: `Próbki geometrii segmentów co ${scoring.sample_step_meters} m`,
            formula: 'segment_sample_count = liczba próbek segmentów wpadających do heksa',
            usage: 'Wejście do network_score.',
          },
          {
            code: 'network_score',
            label: 'Score sieci',
            valueType: 'Znormalizowany score 0-100',
            source: 'segment_sample_count',
            formula: h3.network_score_formula,
            usage: '20% balanced hex_score i jeden z pure route scenarios.',
          },
          {
            code: 'quality_score',
            label: 'Jakość segmentów',
            valueType: 'Agregowany score 0-100',
            source: 'segments.geojson -> properties.score',
            formula: h3.quality_score_formula,
            usage: '35% balanced hex_score i metryka quality w vibe.',
            note:
              'To nie jest dostęp do infrastruktury. To średni końcowy score segmentów przypisanych do heksa.',
          },
          {
            code: 'hex_score',
            label: 'Score heksa H3',
            valueType: 'Finalny score 0-100 dla komórki',
            source: 'demand_score + network_score + quality_score',
            formula: h3.cell_score_formula,
            usage: 'Scenariusz zbalansowany, ranking komórek H3, wybór hubów i edge_h3_score.',
          },
          {
            code: 'mean_greenery_score',
            label: 'Średni score zieleni w heksie',
            valueType: 'Agregowany score 0-100',
            source: 'segments.geojson -> properties.greenery_score',
            formula: 'mean_greenery_score = mean(segment.greenery_score sampled in cell)',
            usage: 'Metryka zieleń otoczenia w vibe i w czystym scenariuszu tras „Zieleń otoczenia 100%”.',
          },
          {
            code: 'mean_noise_score',
            label: 'Średni score ciszy w heksie',
            valueType: 'Agregowany score 0-100',
            source: 'segments.geojson -> properties.noise_score',
            formula: 'mean_noise_score = mean(segment.noise_score sampled in cell)',
            usage: 'Metryka spokój akustyczny w vibe i w czystym scenariuszu tras „Spokój akustyczny 100%”.',
          },
          {
            code: 'mean_rack_score',
            label: 'Średni score dostępu do stojaków',
            valueType: 'Agregowany score 0-100',
            source: 'segments.geojson -> properties.rack_score',
            formula: 'mean_rack_score = mean(segment.rack_score sampled in cell)',
            usage: 'Metryka dostęp do stojaków w vibe i w czystym scenariuszu tras „Dostęp do stojaków 100%”.',
          },
          {
            code: 'mean_infrastructure_score',
            label: 'Średni score dostępu do infrastruktury',
            valueType: 'Agregowany score 0-100',
            source: 'segments.geojson -> properties.infrastructure_score',
            formula:
              'mean_infrastructure_score = mean(segment.infrastructure_score sampled in cell)',
            usage:
              'Metryka dostęp do infrastruktury w vibe i w czystym scenariuszu tras „Dostęp do infrastruktury 100%”.',
          },
          {
            code: 'air_proxy_score',
            label: 'Jakość powietrza (przybliżenie)',
            valueType: 'Agregowany score 0-100',
            source: 'mean_greenery_score + mean_noise_score',
            formula: 'air_proxy_score = mean_greenery_score*0.55 + mean_noise_score*0.45',
            usage: 'Metryka w vibe „Zdrowie”, „Post-apo” i w czystym scenariuszu tras „Jakość powietrza 100%”.',
            note:
              'To proxy, bo w paczce challenge nie ma osobnej warstwy jakości powietrza.',
          },
          {
            code: 'rack_density_score',
            label: 'Gęstość stojaków',
            valueType: 'Znormalizowany score 0-100',
            source: 'rack_count',
            formula: 'rack_density_score = normalize(rack_count, maxRackCount)',
            usage: 'Metryka vibe i w czystym scenariuszu tras „Gęstość stojaków 100%”.',
          },
          {
            code: 'infrastructure_density_score',
            label: 'Gęstość infrastruktury',
            valueType: 'Znormalizowany score 0-100',
            source: 'infrastructure_count',
            formula:
              'infrastructure_density_score = normalize(infrastructure_count, maxInfrastructureCount)',
            usage: 'Metryka vibe i w czystym scenariuszu tras „Gęstość infrastruktury 100%”.',
          },
          {
            code: 'covered_segment_count',
            label: 'Liczba segmentów pokrytych',
            valueType: 'Surowa liczba unikalnych segmentów',
            source: 'Segmenty przechodzące przez heks',
            formula: 'covered_segment_count = liczba unikalnych segment_id w heksie',
            usage: 'Opis geometrii heksa, nie wchodzi bezpośrednio do hex_score.',
          },
          {
            code: 'total_segment_length_km',
            label: 'Łączna długość segmentów',
            valueType: 'Surowa suma długości',
            source: 'Segmenty przechodzące przez heks',
            formula: 'total_segment_length_km = suma(length_km unikalnych segmentów w heksie)',
            usage: 'Opis skali obecnej sieci w komórce.',
          },
        ],
      },
      {
        title: 'Vibe i kolor heksa',
        intro:
          'Kolor heksa nie jest dziś równy jednemu score. To osobna warstwa wizualna liczona z aktywnych vibe.',
        items: [
          {
            code: 'vibe_score',
            label: 'Score pojedynczego vibe',
            valueType: 'Ważona średnia 0-100',
            source: 'Aktywne metryki 0-100 z heksa + wagi vibe',
            formula:
              'vibe_score = weighted_mean(metric lub 100-metric dla wag ujemnych, ważone przez |waga|)',
            usage: 'Określa, jak mocno dany vibe pasuje do komórki.',
          },
          {
            code: 'display_color',
            label: 'Kolor heksa na mapie',
            valueType: 'Wartość wizualna',
            source: 'Wszystkie aktywne vibe i ich kolory bazowe',
            formula: 'display_color = mix RGB aktywnych vibe, ważony ich vibe_score',
            usage:
              'Tylko render warstwy hexes-fill. Kolor mapy może być inny niż sam hex_score liczony do routingu.',
          },
          {
            code: 'dominant_vibe',
            label: 'Dominujący vibe',
            valueType: 'Etykieta pochodna',
            source: 'Najwyższy vibe_score w danym heksie',
            formula: 'dominant_vibe = argmax(vibe_score)',
            usage: 'Opis dominującego charakteru komórki.',
          },
        ],
      },
      {
        title: 'Korytarze',
        intro:
          'To metryki liczone dla rekomendowanej trasy po istniejącym grafie segmentów rowerowych.',
        items: [
          {
            code: 'path_cost',
            label: 'Koszt trasy',
            valueType: 'Koszt routingu',
            source: 'Graf segmentów + edge score scenariusza',
            formula: currentScenario.edge_cost_formula,
            usage: 'Dijkstra minimalizuje właśnie ten koszt.',
          },
          {
            code: 'pair_priority',
            label: 'Priorytet pary hubów',
            valueType: 'Priorytet kandydatury',
            source: 'Dwa wybrane huby H3 i ich route_score',
            formula: currentScenario.pair_priority_formula,
            usage: 'Sortuje kandydatów par hubów przed odpaleniem pełnego pathfindingu.',
          },
          {
            code: 'direct_distance_km',
            label: 'Dystans prosty',
            valueType: 'Surowa odległość',
            source: 'Środki dwóch hubów H3',
            formula: 'direct_distance_km = odległość w linii prostej między hubami / 1000',
            usage: 'Porównanie dystansu prostego do rzeczywistej długości trasy.',
          },
          {
            code: 'path_length_km',
            label: 'Długość trasy',
            valueType: 'Agregowana suma długości',
            source: 'Krawędzie grafu przebyte przez Dijkstrę',
            formula: 'path_length_km = suma(length_m traversed_edges) / 1000',
            usage: 'Opis rzeczywistej długości rekomendowanego korytarza.',
          },
          {
            code: 'mean_segment_score',
            label: 'Średni score segmentów korytarza',
            valueType: 'Agregowany score 0-100',
            source: 'score segmentów na trasie',
            formula: 'mean_segment_score = mean(segment.score dla segmentów na trasie)',
            usage: 'Opis jakości trasy w kategoriach segmentowych.',
          },
          {
            code: 'mean_h3_score',
            label: 'Średni score H3 korytarza',
            valueType: 'Agregowany score 0-100',
            source: 'edge_h3_score krawędzi na trasie',
            formula: 'mean_h3_score = mean(edge_h3_score dla krawędzi na trasie)',
            usage: 'Pokazuje, po jakich komórkach H3 przebiega korytarz.',
          },
        ],
      },
      {
        title: 'Łączniki',
        intro:
          'To kandydaci nowych krótkich odcinków między rozłącznymi komponentami sieci, a nie istniejące ścieżki z plików wejściowych.',
        items: [
          {
            code: 'priority_score',
            label: 'Priorytet łącznika',
            valueType: 'Finalny score 0-100',
            source: 'Popyt komponentu docelowego + wielkość komponentu + długość + środowisko + przecięcia',
            formula: connector.scenario.priority_formula,
            usage: 'Ranking kandydatów łączników.',
          },
          {
            code: 'demand_gain_points',
            label: 'Zysk popytu',
            valueType: 'Punkty pochodne',
            source: 'Waga popytu komponentu docelowego',
            formula: 'demand_gain_points = normalize(target_component_demand_weight, maxDemandWeight) * 0.45',
            usage: 'Premiuje dołączanie komponentów z większym popytem.',
          },
          {
            code: 'network_gain_points',
            label: 'Zysk sieci',
            valueType: 'Punkty pochodne',
            source: 'Liczba węzłów i krawędzi komponentu docelowego',
            formula:
              'network_gain_points = normalize(node_count, maxNodeCount)*0.15 + normalize(edge_count, maxEdgeCount)*0.10',
            usage: 'Premiuje dołączanie większych i bardziej wartościowych komponentów.',
          },
          {
            code: 'distance_points',
            label: 'Punkty za dystans',
            valueType: 'Punkty pochodne',
            source: 'Długość kandydata łącznika',
            formula: `distance_points = scaleDescending(length_m, ${connector.scenario.min_connector_length_meters}, ${connector.scenario.max_connector_length_meters}) * 0.20`,
            usage: 'Premiuje krótsze łączniki mieszczące się w dopuszczalnym zakresie.',
          },
          {
            code: 'environment_points',
            label: 'Punkty środowiskowe',
            valueType: 'Punkty pochodne',
            source: 'Zieleń i hałas próbek łącznika',
            formula: 'environment_points = greenery_ratio*10 + noise_score*0.1',
            usage: 'Premiuje spokojniejsze i bardziej zielone kandydaty.',
          },
          {
            code: 'crossing_penalty_points',
            label: 'Kara za przecięcia',
            valueType: 'Punkty ujemne',
            source: 'Przecięcia łącznika z istniejącą siecią',
            formula: 'crossing_penalty_points = min(network_crossings_count * 3, 15)',
            usage: 'Obniża priorytet kandydatów przecinających istniejącą sieć.',
          },
        ],
      },
      {
        title: 'Statystyki przestrzenne',
        intro:
          'To pomocnicze miary opisujące układ punktów i hubów w przestrzeni Krakowa.',
        items: [
          {
            code: 'mean_center',
            label: 'Środek ciężkości',
            valueType: 'Agregowana statystyka przestrzenna',
            source: 'Zbiór punktów danego typu',
            formula: 'mean_center = [mean(lon), mean(lat)]',
            usage: 'Pokazuje przeciętny środek rozkładu punktów.',
          },
          {
            code: 'nearest_neighbor_index',
            label: 'NNI',
            valueType: 'Statystyka przestrzenna',
            source: 'Odległości do najbliższego sąsiada + bounding box analizowanego zbioru',
            formula:
              'NNI = observed_mean_distance / expected_mean_distance_random',
            usage:
              'Pomaga ocenić, czy punkty są skupione, rozproszone czy bliskie losowym.',
          },
          {
            code: 'standard_deviational_ellipse',
            label: 'Elipsa odchylenia standardowego',
            valueType: 'Statystyka przestrzenna',
            source: 'Projected coordinates danego zbioru punktów',
            formula:
              'oś główna i pomocnicza wynikają z wariancji i kowariancji współrzędnych po projekcji do metrów',
            usage: 'Pokazuje dominujący kierunek i rozrzut przestrzenny zjawiska.',
          },
        ],
      },
    ]
  }

  function hexMetricsRows(hex: H3CellSummary) {
    const vector = buildHexMetricVector(hex)

    return [
      { code: 'hex_score', label: 'Score heksa', raw: formatScore(hex.hex_score), normalized: formatScore(hex.hex_score) },
      { code: 'demand_score', label: 'Score popytu', raw: formatFixed(hex.demand_weight, 1), normalized: formatScore(vector.demand) },
      { code: 'network_score', label: 'Score sieci', raw: formatCount(hex.segment_sample_count), normalized: formatScore(vector.network) },
      { code: 'quality_score', label: 'Score jakości', raw: formatScore(hex.mean_segment_score), normalized: formatScore(vector.quality) },
      { code: 'mean_greenery_score', label: 'Zieleń otoczenia', raw: formatPercent(hex.mean_greenery_ratio), normalized: formatScore(vector.greenery) },
      { code: 'mean_noise_score', label: 'Spokój akustyczny', raw: formatNoise(hex.max_noise_db), normalized: formatScore(vector.quietness) },
      { code: 'mean_rack_score', label: 'Dostęp do stojaków', raw: formatDistance(hex.mean_nearest_rack_m), normalized: formatScore(vector.rack_access) },
      {
        code: 'mean_infrastructure_score',
        label: 'Dostęp do infrastruktury',
        raw: formatDistance(hex.mean_nearest_infra_m),
        normalized: formatScore(vector.infrastructure_access),
      },
      { code: 'rack_density_score', label: 'Gęstość stojaków', raw: formatCount(hex.rack_count), normalized: formatScore(vector.rack_density) },
      {
        code: 'infrastructure_density_score',
        label: 'Gęstość infrastruktury',
        raw: formatCount(hex.infrastructure_count),
        normalized: formatScore(vector.infrastructure_density),
      },
      { code: 'air_proxy_score', label: 'Jakość powietrza (przybliżenie)', raw: `${formatScore(vector.air_proxy)}/100`, normalized: formatScore(vector.air_proxy) },
      {
        code: 'total_segment_length_km',
        label: 'Łączna długość segmentów',
        raw: formatKilometers(hex.total_segment_length_km),
        normalized: formatCount(hex.covered_segment_count),
      },
    ]
  }

  function topVibesForHex(hex: H3CellSummary) {
    return analyzeHexVibes(hex).scores.sort((left, right) => right.score - left.score)
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
            <p class="mt-1 text-xs text-stone-500">${escapeHtml(item.raw)} • wynik czastkowy ${formatScore(item.score)}/100 • waga ${escapeHtml(formatWeight(item.weight))}</p>
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
        <div class="mb-3 rounded-xl bg-stone-50 px-3 py-2 text-xs leading-6 text-stone-600">
          Score segmentu = finalna ocena istniejącego odcinka 0-100. Wzór: zieleń 35% + hałas 30% + stojaki 20% + infrastruktura 15%.
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
    const scenarioLabel = scenarioDisplayLabel({
      label: corridor.scenario_label ?? 'brak scenariusza',
      metric_key: corridor.route_metric_key ?? null,
    })

    return `
      <div class="w-[19rem] bg-white p-4 text-stone-900">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Korytarz #${corridor.corridor_rank}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(corridor.label)}</h3>
            <p class="mt-1 text-xs text-stone-500">${escapeHtml(scenarioLabel)}</p>
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
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Łącznik #${connector.connector_rank}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(connector.label)}</h3>
            <p class="mt-1 text-xs text-stone-500">Kandydat planistyczny, nie istniejący odcinek z danych.</p>
          </div>
          <span class="rounded-full bg-red-500 px-3 py-1 text-sm font-semibold text-white">${formatScore(connector.priority_score)}</span>
        </div>
        <dl class="grid grid-cols-2 gap-3 text-sm text-stone-700">
          <div><dt class="text-stone-500">Dlugosc</dt><dd class="font-medium text-stone-900">${formatKilometers(connector.length_km)}</dd></div>
          <div><dt class="text-stone-500">Przeciecia z siecia</dt><dd class="font-medium text-stone-900">${formatCount(connector.network_crossings_count)}</dd></div>
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
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Hub H3</p>
        <h3 class="mt-1 text-base font-semibold text-stone-950">${escapeHtml(hotspot.label)}</h3>
        <p class="mt-1 text-xs text-stone-500">Punkt reprezentujący wybraną komórkę H3 do trasowania.</p>
        <dl class="mt-3 space-y-2 text-sm text-stone-700">
          <div><dt class="text-stone-500">Score heksa</dt><dd class="font-medium text-stone-900">${formatScore(hotspot.hex_score)}</dd></div>
          <div><dt class="text-stone-500">H3 index</dt><dd class="font-medium text-stone-900">${escapeHtml(hotspot.h3_index)}</dd></div>
          <div><dt class="text-stone-500">Wszystkie punkty</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.point_count)}</dd></div>
          <div><dt class="text-stone-500">Stojaki</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.rack_count)}</dd></div>
          <div><dt class="text-stone-500">Infrastruktura</dt><dd class="font-medium text-stone-900">${formatCount(hotspot.infrastructure_count)}</dd></div>
          <div><dt class="text-stone-500">Sredni score segmentu</dt><dd class="font-medium text-stone-900">${formatScore(hotspot.mean_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Scenariusz</dt><dd class="font-medium text-stone-900">${escapeHtml(hotspot.scenario_label ?? 'brak')}</dd></div>
          <div><dt class="text-stone-500">Snap do grafu</dt><dd class="font-medium text-stone-900">${formatDistance(hotspot.snap_distance_m)}</dd></div>
        </dl>
      </div>
    `
  }

  function buildHexPopup(hex: H3CellSummary) {
    const vibe = analyzeHexVibes(hex)
    const vibeHtml = vibe.scores
      .slice()
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(
        (item) =>
          `<div class="flex items-center justify-between gap-3"><span class="font-medium text-stone-900">${escapeHtml(item.label)}</span><span class="rounded-full px-2.5 py-1 text-xs font-semibold text-white" style="background:${item.color}">${formatScore(item.score)}</span></div>`,
      )
      .join('')

    return `
      <div class="w-[18rem] bg-white p-4 text-stone-900">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Komorka H3</p>
        <h3 class="mt-1 text-base font-semibold text-stone-950">${escapeHtml(hex.h3_index)}</h3>
        <p class="mt-1 text-xs text-stone-500">Wynik obszaru H3 = popyt 45% + obecność sieci 20% + ogólna jakość segmentów 35%.</p>
        <dl class="mt-3 space-y-2 text-sm text-stone-700">
          <div><dt class="text-stone-500">Score heksa</dt><dd class="font-medium text-stone-900">${formatScore(hex.hex_score)}</dd></div>
          <div><dt class="text-stone-500">Dominujacy vibe</dt><dd class="font-medium text-stone-900">${escapeHtml(vibe.dominant?.label ?? 'brak')}</dd></div>
          <div><dt class="text-stone-500">Score popytu</dt><dd class="font-medium text-stone-900">${formatScore(hex.demand_score)}</dd></div>
          <div><dt class="text-stone-500">Score sieci</dt><dd class="font-medium text-stone-900">${formatScore(hex.network_score)}</dd></div>
          <div><dt class="text-stone-500">Ogólna jakość segmentów</dt><dd class="font-medium text-stone-900">${formatScore(hex.quality_score)}</dd></div>
          <div><dt class="text-stone-500">Punkty popytu</dt><dd class="font-medium text-stone-900">${formatCount(hex.point_count)}</dd></div>
          <div><dt class="text-stone-500">Probki segmentow</dt><dd class="font-medium text-stone-900">${formatCount(hex.segment_sample_count)}</dd></div>
          <div><dt class="text-stone-500">Sredni score segmentu</dt><dd class="font-medium text-stone-900">${formatScore(hex.mean_segment_score)}</dd></div>
          <div><dt class="text-stone-500">Max halas</dt><dd class="font-medium text-stone-900">${formatNoise(hex.max_noise_db)}</dd></div>
        </dl>
        <div class="mt-4 space-y-2">
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Miks vibe</p>
          ${vibeHtml}
        </div>
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
  <title>Vibe your Trip 🤙</title>
  <meta
    name="description"
    content="Vibe your Trip 🤙 — prosta aplikacja do wybierania rowerowej trasy w Krakowie na podstawie vibe, H3 i istniejącej sieci rowerowej."
  />
</svelte:head>

<div class="min-h-screen bg-stone-50 text-stone-950">
  <main class="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
    <header class="grid gap-5 rounded-[0.5rem] border border-stone-200 bg-white p-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)]">
      <div class="space-y-4">
        <span class="inline-flex w-fit items-center rounded-[0.35rem] border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-blue-900">
          Vibe your Trip 🤙
        </span>
        <div class="space-y-3">
          <h1 class="max-w-4xl text-4xl font-semibold leading-tight tracking-tight text-stone-950 sm:text-5xl">
            Wybierz vibe i znajdz trase, ktora najlepiej pasuje do Twojego przejazdu.
          </h1>
          <p class="max-w-3xl text-base leading-8 text-stone-700 sm:text-lg">
            Ustaw klimat przejazdu, zaznacz punkt <span class="font-semibold text-stone-950">A</span> i
            <span class="font-semibold text-stone-950">B</span>, a aplikacja wyznaczy trase po
            istniejacej sieci rowerowej w Krakowie. Wybrany vibe wplywa na wyglad mapy i na to,
            jak aplikacja dobiera trase.
          </p>
        </div>
      </div>

      <div class="rounded-[0.5rem] border border-stone-200 bg-stone-50 p-4">
        <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
          Vibe dnia
        </p>
        <div class="mt-3 space-y-3">
          {#each mockVibeSuggestions as suggestion}
            <button
              class="w-full overflow-hidden rounded-[0.4rem] border border-stone-200 bg-white text-left transition hover:border-blue-300 hover:bg-blue-50"
              onclick={() => applyVibeSelection(suggestion.vibeIds)}
              type="button"
            >
              <div class="grid min-h-28 grid-cols-[6.5rem_minmax(0,1fr)]">
                <div class="relative min-h-full">
                  <img
                    alt={suggestion.title}
                    class="absolute inset-0 h-full w-full object-cover"
                    loading="lazy"
                    src={suggestion.imagePath}
                  />
                  <div class="absolute inset-0 bg-gradient-to-r from-black/20 via-black/10 to-transparent"></div>
                </div>
                <div class="flex items-center justify-between gap-3 px-4 py-3">
                  <div class="min-w-0">
                    <p class="text-sm font-semibold text-stone-950">{suggestion.title}</p>
                    <p class="mt-1 text-xs leading-5 text-stone-500">{suggestion.note}</p>
                  </div>
                  <span class="shrink-0 rounded-[0.35rem] bg-blue-600 px-3 py-1 text-xs font-semibold text-white">
                    Ustaw vibe
                  </span>
                </div>
              </div>
            </button>
          {/each}
        </div>
      </div>
    </header>

    {#if error}
      <section class="rounded-[0.5rem] border border-red-200 bg-red-50 p-6 text-red-900">
        <h2 class="text-xl font-semibold">Nie udalo sie uruchomic wizualizacji</h2>
        <p class="mt-3 text-sm leading-7">{error}</p>
        <pre class="mt-4 overflow-x-auto rounded-[0.35rem] bg-white/80 p-4 text-xs text-stone-800">npm run prepare:cycling-data
npm run dev</pre>
      </section>
    {:else}
      <section class="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_24rem]">
        <div class="overflow-hidden rounded-[0.5rem] border border-stone-300 bg-white">
          <div class="flex flex-col gap-4 border-b border-stone-200 px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Mapa Krakowa</p>
                <h2 class="text-2xl font-semibold tracking-tight text-stone-950">
                  Kolor miasta = vibe, kolor sciezek = komfort
                </h2>
              </div>

              <div class="flex flex-wrap gap-2">
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-[0.35rem] px-4 py-2 text-sm font-medium transition ${showHexes ? 'bg-blue-600 text-white' : 'bg-stone-100 text-stone-700'}`} title="Pokazuje siatke obszarow H3 pokolorowanych wedlug aktywnego vibe">
                  <input bind:checked={showHexes} class="sr-only" type="checkbox" />
                  <span>Obszary vibe</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-[0.35rem] px-4 py-2 text-sm font-medium transition ${showRacks ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`} title="Pokazuje stojaki rowerowe z danych ZTP">
                  <input bind:checked={showRacks} class="sr-only" type="checkbox" />
                  <span>Stojaki rowerowe</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-[0.35rem] px-4 py-2 text-sm font-medium transition ${showInfrastructure ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`} title="Pokazuje punktowa infrastrukture rowerowa z danych ZTP, inna niz stojaki">
                  <input bind:checked={showInfrastructure} class="sr-only" type="checkbox" />
                  <span>Infrastruktura punktowa</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-[0.35rem] px-4 py-2 text-sm font-medium transition ${showHotspots ? 'bg-orange-500 text-white' : 'bg-stone-100 text-stone-700'}`} title="Pokazuje glowne huby H3 uzywane do rekomendowanych tras">
                  <input bind:checked={showHotspots} class="sr-only" type="checkbox" />
                  <span>Huby tras</span>
                </label>
                <button
                  title={hasVisiblePointMarkers ? 'Ukrywa wszystkie punktowe znaczniki: stojaki, infrastrukture punktowa i huby tras' : 'Pokazuje wszystkie punktowe znaczniki: stojaki, infrastrukture punktowa i huby tras'}
                  class={`rounded-[0.35rem] px-4 py-2 text-sm font-medium transition ${hasVisiblePointMarkers ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-stone-100 text-stone-700 hover:bg-stone-200'}`}
                  onclick={toggleAllPointMarkers}
                  type="button"
                >
                  {hasVisiblePointMarkers ? 'Ukryj znaczniki' : 'Pokaz znaczniki'}
                </button>
                <button
                  title="Przywraca widok na Krakow i dane z calego obszaru"
                  class="rounded-[0.35rem] bg-white px-4 py-2 text-sm font-medium text-stone-700 ring-1 ring-stone-300 transition hover:bg-stone-50"
                  onclick={resetView}
                  type="button"
                >
                  Reset widoku
                </button>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              {#each scoreLegend as item}
                <div class="inline-flex items-center gap-2 rounded-[0.35rem] bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700">
                  <span class="size-2.5 rounded-full" style={`background:${item.color}`}></span>
                  <span>{item.label}</span>
                </div>
              {/each}
              <div class="inline-flex items-center gap-2 rounded-[0.35rem] bg-blue-100 px-3 py-1 text-xs font-medium text-blue-800">
                <span class="size-2.5 rounded-full bg-blue-600"></span>
                <span>Podklad mapy</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-[0.35rem] bg-blue-100 px-3 py-1 text-xs font-medium text-blue-900">
                <span class="size-2.5 rounded-full bg-blue-600"></span>
                <span>Siatka H3 / vibe</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-[0.35rem] bg-orange-100 px-3 py-1 text-xs font-medium text-orange-900">
                <span class="size-2.5 rounded-full bg-orange-500"></span>
                <span>Hub H3</span>
              </div>
              <div class="inline-flex items-center gap-2 rounded-[0.35rem] bg-violet-100 px-3 py-1 text-xs font-medium text-violet-900">
                <span class="size-2.5 rounded-full bg-violet-500"></span>
                <span>Twoja trasa A → B</span>
              </div>
            </div>
            <div class="mt-3 rounded-[0.35rem] border border-stone-200 bg-stone-50 px-3 py-3 text-xs leading-6 text-stone-600">
              <p>
                <span class="font-semibold text-stone-900">Kolor sciezek</span>
                = komfort segmentu liczony z zieleni, halasu, stojakow i infrastruktury.
              </p>
              <p class="mt-1">
                <span class="font-semibold text-stone-900">Kolor heksow H3</span>
                = miks aktywnych vibe. Ten sam zestaw vibe steruje tez kosztem trasy A -> B.
              </p>
              <p class="mt-1">
                <span class="font-semibold text-stone-900">Infrastruktura punktowa</span>
                = punktowe obiekty rowerowe z danych ZTP, inne niz stojaki rowerowe.
              </p>
            </div>
          </div>

          <div class="relative">
            <div bind:this={mapContainer} class="h-[70vh] min-h-[30rem] w-full"></div>

            {#if isLoading}
              <div class="absolute inset-0 flex items-center justify-center bg-white/65 backdrop-blur-sm">
                <div class="rounded-[0.4rem] border border-stone-200 bg-white px-5 py-4 text-sm font-medium text-stone-700">
                  Wczytywanie mapy i warstw...
                </div>
              </div>
            {/if}
          </div>
        </div>

        <aside class="space-y-4">
          {#if summary}
            <section class="rounded-[0.5rem] border border-blue-200 bg-white p-5">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-blue-600">Trasa A → B</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Routing po ścieżkach rowerowych
                  </h3>
                </div>
                {#if routeResult}
                  <span class="rounded-[0.35rem] bg-blue-600 px-3 py-1 text-sm font-semibold text-white">
                    {(routeResult.total_length_m / 1000).toFixed(2)} km
                  </span>
                {/if}
              </div>

              {#if isGraphBuilding}
                <p class="mt-3 text-sm text-stone-600">Budowanie grafu z {summary.counts.cycling_path_segments} segmentow...</p>
              {:else if !routingGraph}
                <p class="mt-3 text-sm text-stone-600">Graf niedostepny.</p>
              {:else}
                <div class="mt-4 space-y-3">
                  <div class="flex gap-2">
                    {#if routingMode === 'idle' && !routeResult}
                      <button
                        class="flex-1 rounded-[0.35rem] bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
                        onclick={startRouting}
                        type="button"
                      >
                        Wyznacz trase
                      </button>
                    {:else if routingMode !== 'idle'}
                      <button
                        class="flex-1 rounded-[0.35rem] bg-stone-200 px-4 py-2.5 text-sm font-semibold text-stone-800 transition hover:bg-stone-300"
                        onclick={cancelRouting}
                        type="button"
                      >
                        Anuluj
                      </button>
                    {:else}
                      <button
                        class="flex-1 rounded-[0.35rem] bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
                        onclick={startRouting}
                        type="button"
                      >
                        Nowa trasa
                      </button>
                      <button
                        class="rounded-[0.35rem] bg-stone-200 px-4 py-2.5 text-sm font-medium text-stone-700 transition hover:bg-stone-300"
                        onclick={cancelRouting}
                        type="button"
                      >
                        Wyczysc
                      </button>
                    {/if}
                  </div>

                  {#if routingMode === 'selectStart'}
                    <div class="rounded-[0.35rem] bg-green-100 px-4 py-3 text-sm text-green-900">
                      Kliknij na mapie, zeby wybrac <span class="font-bold">punkt A</span> (start).
                    </div>
                  {:else if routingMode === 'selectEnd'}
                    <div class="rounded-[0.35rem] bg-red-100 px-4 py-3 text-sm text-red-900">
                      Kliknij na mapie, zeby wybrac <span class="font-bold">punkt B</span> (cel).
                    </div>
                  {/if}

                  {#if routeStart}
                    <div class="flex items-center gap-2 rounded-[0.35rem] bg-white px-3 py-2 text-sm">
                      <span class="inline-flex size-6 items-center justify-center rounded-[0.3rem] bg-green-500 text-xs font-bold text-white">A</span>
                      <span class="text-stone-700">{routeStart.coordinate[1].toFixed(5)}, {routeStart.coordinate[0].toFixed(5)}</span>
                      <span class="text-stone-400">({Math.round(routeStart.snap_distance_m)} m snap)</span>
                    </div>
                  {/if}
                  {#if routeEnd}
                    <div class="flex items-center gap-2 rounded-[0.35rem] bg-white px-3 py-2 text-sm">
                      <span class="inline-flex size-6 items-center justify-center rounded-[0.3rem] bg-red-500 text-xs font-bold text-white">B</span>
                      <span class="text-stone-700">{routeEnd.coordinate[1].toFixed(5)}, {routeEnd.coordinate[0].toFixed(5)}</span>
                      <span class="text-stone-400">({Math.round(routeEnd.snap_distance_m)} m snap)</span>
                    </div>
                  {/if}

                  {#if routeError}
                    <div class="rounded-[0.35rem] bg-red-100 px-4 py-3 text-sm text-red-900">{routeError}</div>
                  {/if}

                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-sm text-stone-700">
                      <span>Sila vibe</span>
                      <span class="font-semibold text-blue-700">{routeAlphaLabel(routeVibeLevel)}</span>
                    </div>
                    <input
                      id="route-vibe-alpha"
                      type="range"
                      min={MIN_ROUTE_VIBE_LEVEL}
                      max={MAX_ROUTE_VIBE_LEVEL}
                      step="1"
                      bind:value={routeVibeLevel}
                      onchange={() => { if (routeStart && routeEnd && routingMode === 'idle') computeRoute() }}
                      class="w-full accent-blue-600"
                    />
                    <div class="flex justify-between text-xs text-stone-400">
                      <span>1 = najkrotsza</span>
                      <span>10 = max vibe</span>
                    </div>
                  </div>

                  <div class="space-y-2 rounded-[0.35rem] border border-blue-200 bg-stone-50 p-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Vibe dla mapy i routingu</p>
                        <p class="mt-1 text-xs leading-5 text-stone-500">
                          Ten sam zestaw steruje jednoczesnie kolorem H3 i kosztem trasy.
                        </p>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="rounded-[0.3rem] bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                          {activeVibeList.length} aktywne
                        </span>
                        <button
                          class="rounded-[0.3rem] bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600 transition hover:bg-stone-200"
                          onclick={clearAllVibes}
                          type="button"
                        >
                          wyczysc vibe
                        </button>
                      </div>
                    </div>

                    {#if activeVibeList.length === 0}
                      <p class="text-xs text-stone-400">Brak aktywnych vibe — routing uzywa tylko dystansu.</p>
                    {:else}
                      <div class="flex flex-wrap gap-2">
                        {#each activeVibeList as vibe (vibe.id)}
                          <div
                            class="inline-flex items-center gap-2 rounded-[0.35rem] px-3 py-1.5 text-xs font-semibold text-white"
                            style={`background:${vibe.color}`}
                          >
                            <span>{vibe.label}</span>
                            <button
                              aria-label={`Usun vibe ${vibe.label}`}
                              class="inline-flex size-5 items-center justify-center rounded-[0.25rem] bg-white/20 text-[11px] font-bold text-white transition hover:bg-white/30"
                              onclick={(event) => { event.stopPropagation(); removeRouteVibe(vibe.id) }}
                              type="button"
                            >
                              x
                            </button>
                          </div>
                        {/each}
                      </div>
                      <p class="text-xs text-stone-500">
                        Aktywne: <span class="font-semibold text-stone-700">{activeVibeList.map((vibe) => vibe.label).join(', ')}</span>
                      </p>
                    {/if}

                    <div class="space-y-2 pt-2">
                      <label class="block space-y-1">
                        <span class="text-xs font-semibold text-stone-700">Dodaj vibe przez wyszukanie</span>
                        <input
                          bind:value={routeVibeSearch}
                          class="w-full rounded-[0.35rem] border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-blue-500"
                          placeholder="Szukaj bazowego, czystego albo wlasnego vibe..."
                          type="text"
                        />
                      </label>

                      {#if !routeVibeSearch.trim()}
                        <p class="text-xs leading-5 text-stone-400">
                          Wpisz nazwe albo fragment opisu, zeby dodac bazowy, czysty albo wlasny vibe. Gdy pole jest puste, panel nie pokazuje domyslnych vibe do dodania.
                        </p>
                      {:else if availableRouteVibeList.length === 0}
                        <p class="text-xs text-stone-400">
                          Brak vibe pasujacych do wyszukiwania.
                        </p>
                      {:else}
                        <div class="max-h-48 space-y-2 overflow-y-auto pr-1">
                          {#each availableRouteVibeList as vibe (vibe.id)}
                            <button
                              class="w-full rounded-[0.35rem] border border-stone-200 bg-white px-3 py-2 text-left transition hover:border-blue-300 hover:bg-blue-50"
                              onclick={() => addRouteVibe(vibe.id)}
                              type="button"
                            >
                              <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                  <div class="flex flex-wrap items-center gap-2">
                                    <span class="text-sm font-semibold text-stone-900">{vibe.label}</span>
                                    <span class="rounded-[0.3rem] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500 ring-1 ring-stone-200">
                                      {vibeKindLabel(vibe)}
                                    </span>
                                  </div>
                                  <p class="mt-1 text-xs leading-5 text-stone-500">{vibe.formula}</p>
                                </div>
                                <span class="mt-0.5 size-5 shrink-0 rounded-full ring-1 ring-black/5" style={`background:${vibe.color}`}></span>
                              </div>
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>

                    <div class="space-y-3 border-t border-stone-200 pt-3">
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">Dodaj własny vibe</p>
                          <p class="mt-1 text-xs leading-5 text-stone-500">
                            Ustaw własne proporcje metryk 0-100. Dodatnia waga wzmacnia metrykę, ujemna odwraca ją do <code class="rounded-[0.2rem] bg-stone-100 px-1">100 - metryka</code>.
                          </p>
                        </div>
                        <button
                          class="rounded-[0.3rem] bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600 transition hover:bg-stone-200"
                          onclick={resetCustomVibeDraft}
                          type="button"
                        >
                          reset
                        </button>
                      </div>

                      <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_5.5rem]">
                        <label class="space-y-1">
                          <span class="text-xs font-semibold text-stone-700">Nazwa</span>
                          <input
                            bind:value={customVibeLabel}
                            class="w-full rounded-[0.35rem] border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-blue-500"
                            type="text"
                          />
                        </label>
                        <label class="space-y-1">
                          <span class="text-xs font-semibold text-stone-700">Kolor</span>
                          <input
                            bind:value={customVibeColor}
                            class="h-10 w-full rounded-[0.35rem] border border-stone-300 bg-white px-2 py-2"
                            type="color"
                          />
                        </label>
                      </div>

                      <div class="grid gap-2">
                        {#each vibeMetricMeta as metric}
                          <label class="rounded-[0.35rem] border border-stone-200 bg-white px-3 py-2">
                            <div class="flex items-center justify-between gap-3">
                              <div class="min-w-0">
                                <p class="text-sm font-semibold text-stone-900">{metric.label}</p>
                                <p class="mt-0.5 text-[11px] leading-5 text-stone-500">{metric.note}</p>
                              </div>
                              <span class="shrink-0 text-xs font-semibold text-blue-700">{customVibeWeights[metric.key]}</span>
                            </div>
                            <input
                              class="mt-2 w-full accent-blue-600"
                              max="100"
                              min="-100"
                              step="5"
                              type="range"
                              value={customVibeWeights[metric.key]}
                              oninput={(event) =>
                                (customVibeWeights = {
                                  ...customVibeWeights,
                                  [metric.key]: Number((event.currentTarget as HTMLInputElement).value),
                                })}
                            />
                          </label>
                        {/each}
                      </div>

                      <div class="flex justify-end">
                        <button
                          class="rounded-[0.35rem] bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
                          onclick={addCustomVibe}
                          type="button"
                        >
                          Dodaj vibe
                        </button>
                      </div>

                      {#if customVibes.length > 0}
                        <div class="space-y-2 border-t border-stone-200 pt-3">
                          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Twoje vibe</p>
                          {#each customVibes as vibe (vibe.id)}
                            <div class={`rounded-[0.35rem] border px-3 py-2 ${isVibeEnabled(vibe.id) ? 'border-blue-300 bg-blue-50' : 'border-stone-200 bg-white'}`}>
                              <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                  <p class="text-sm font-semibold text-stone-900">{vibe.label}</p>
                                  <p class="mt-1 text-xs leading-5 text-stone-500">{vibe.formula}</p>
                                </div>
                                <div class="flex items-center gap-2">
                                  <span class="size-4 shrink-0 rounded-[0.2rem]" style={`background:${vibe.color}`}></span>
                                  <button
                                    class={`rounded-[0.3rem] px-2.5 py-1 text-[11px] font-semibold transition ${isVibeEnabled(vibe.id) ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}
                                    onclick={() => toggleVibe(vibe.id)}
                                    type="button"
                                  >
                                    {isVibeEnabled(vibe.id) ? 'aktywne' : 'dodaj'}
                                  </button>
                                  <button
                                    class="rounded-[0.3rem] bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600 transition hover:bg-stone-200"
                                    onclick={() => removeCustomVibe(vibe.id)}
                                    type="button"
                                  >
                                    usun
                                  </button>
                                </div>
                              </div>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>

                {#if routeResult}
                  <dl class="mt-4 grid grid-cols-2 gap-3 text-sm text-stone-700">
                    <div class="rounded-[0.35rem] bg-white px-4 py-3">
                      <dt class="text-stone-500">Dystans</dt>
                      <dd class="mt-1 text-lg font-semibold text-stone-950">{(routeResult.total_length_m / 1000).toFixed(2)} km</dd>
                    </div>
                    <div class="rounded-[0.35rem] bg-white px-4 py-3">
                      <dt class="text-stone-500">Czas (~15 km/h)</dt>
                      <dd class="mt-1 text-lg font-semibold text-stone-950">{Math.ceil(routeResult.total_length_m / 250)} min</dd>
                    </div>
                    <div class="rounded-[0.35rem] bg-white px-4 py-3">
                      <dt class="text-stone-500">Segmenty</dt>
                      <dd class="mt-1 text-lg font-semibold text-stone-950">{routeResult.segment_count}</dd>
                    </div>
                    <div class="rounded-[0.35rem] bg-white px-4 py-3">
                      <dt class="text-stone-500">Sredni score</dt>
                      <dd class="mt-1 text-lg font-semibold" style={`color:${scoreColor(routeResult.mean_score)}`}>{formatScore(routeResult.mean_score)}</dd>
                    </div>
                  </dl>

                  <div class="mt-3 rounded-[0.35rem] border border-blue-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
                    <p>
                      Trasa znaleziona algorytmem <span class="font-semibold text-stone-900">A*</span> po grafie {summary.network_analysis.nodes} wezlow
                      i {summary.network_analysis.edges} krawedzi. Koszt krawedzi: <code class="rounded-[0.2rem] bg-stone-100 px-1 text-xs">length × (1 + α × ((100−vibe)/100)^1.5)</code>.
                      {#if routeVibeAlphaValue(routeVibeLevel) > 0}
                        Aktywne vibe wplywaja na score krawedzi — trasa preferuje segmenty o wyzszym vibe.
                      {:else}
                        Przy α = 0 trasa jest najkrotsza pod wzgledem dystansu.
                      {/if}
                    </p>
                    <p class="mt-2 text-xs text-stone-500">
                      Kara jest eksponencjalna: <code class="rounded-[0.2rem] bg-stone-100 px-1">((100−vibe)/100)^1.5</code>. Dla poziomu {routeVibeLevel}/10 (α={routeVibeAlphaValue(routeVibeLevel).toFixed(1)}) odcinek z vibe=0 kosztuje <code class="rounded-[0.2rem] bg-stone-100 px-1">{routeMultiplierForVibe(routeVibeLevel, 0).toFixed(1)}×</code>, a z vibe=50 kosztuje <code class="rounded-[0.2rem] bg-stone-100 px-1">{routeMultiplierForVibe(routeVibeLevel, 50).toFixed(1)}×</code> swoja dlugosc.
                    </p>
                  </div>
                {/if}
              {/if}
            </section>

            <div class="hidden">
            <section class="rounded-[1.5rem] border border-purple-300 bg-purple-50/80 p-5 shadow-lg shadow-purple-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-purple-600">Izochrony</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Zasieg z punktu
                  </h3>
                </div>
                {#if isochroneResult}
                  <span class="rounded-full bg-purple-600 px-3 py-1 text-sm font-semibold text-white">
                    {isochroneResult.bands.length} pasma
                  </span>
                {/if}
              </div>

              {#if routingGraph}
                <p class="mt-3 text-sm text-stone-600">
                  Kliknij punkt na mapie, a system pokaze obszary osiagalne w promieniu 1, 2.5, 5 i 10 km po sciezkach rowerowych.
                </p>
                <div class="mt-3 flex gap-2">
                  {#if isochroneMode}
                    <button
                      class="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white animate-pulse"
                      onclick={cancelIsochrone}
                      type="button"
                    >
                      Kliknij na mapie...
                    </button>
                  {:else}
                    <button
                      class="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-700"
                      onclick={startIsochrone}
                      type="button"
                    >
                      {isochroneResult ? 'Nowa izochrona' : 'Wyznacz izochrony'}
                    </button>
                    {#if isochroneResult}
                      <button
                        class="rounded-xl bg-stone-200 px-4 py-2.5 text-sm font-medium text-stone-700 transition hover:bg-stone-300"
                        onclick={cancelIsochrone}
                        type="button"
                      >
                        Wyczysc
                      </button>
                    {/if}
                  {/if}
                </div>

                {#if isochroneResult}
                  <div class="mt-3 space-y-2">
                    {#each isochroneResult.bands as band, i}
                      <div class="flex items-center gap-3 rounded-xl bg-white px-3 py-2 text-sm">
                        <span class="size-3 rounded-full" style={`background: ${['#a78bfa','#8b5cf6','#6d28d9','#4c1d95'][i]}`}></span>
                        <span class="font-semibold text-stone-900">{band.label}</span>
                        <span class="text-stone-500">({band.coordinates.length - 1} wezlow na obwodce)</span>
                      </div>
                    {/each}
                  </div>
                  <div class="mt-3 rounded-[1.25rem] border border-purple-200 bg-white px-4 py-3 text-sm leading-6 text-stone-600">
                    Izochrony sa obliczone algorytmem <span class="font-semibold text-stone-900">Dijkstra</span> (bez celu, pelna eksploracja)
                    po fizycznej dlugosci krawedzi. Kontury to <span class="font-semibold text-stone-900">convex hull</span> osiagalnych wezlow.
                  </div>
                {/if}
              {:else}
                <p class="mt-3 text-sm text-stone-500">Graf niedostepny.</p>
              {/if}
            </section>

            <section class="rounded-[1.5rem] border border-amber-300 bg-amber-50/80 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700">Centralnosc sieci</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Betweenness Centrality
                  </h3>
                </div>
                {#if centralityResult}
                  <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showBetweenness ? 'bg-amber-600 text-white' : 'bg-stone-100 text-stone-700'}`}>
                    <input type="checkbox" class="sr-only" bind:checked={showBetweenness} onchange={syncCentralityDisplay} />
                    <span>{showBetweenness ? 'Widoczna' : 'Ukryta'}</span>
                  </label>
                {/if}
              </div>

              {#if routingGraph}
                <p class="mt-3 text-sm text-stone-600">
                  Analiza mierzy, ile najkrotszych tras przechodzi przez kazdy segment — im wyzszy wynik, tym wazniejszy jest
                  segment jako lacznik w sieci. Segmenty o wysokiej centralnosci to potencjalne waskie gardla.
                </p>
                <div class="mt-3">
                  {#if isCentralityComputing}
                    <button class="w-full rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-amber-950 animate-pulse" disabled type="button">
                      Obliczanie (algorytm Brandesa)...
                    </button>
                  {:else if centralityResult}
                    <button
                      class="w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-700"
                      onclick={runCentralityAnalysis}
                      type="button"
                    >
                      Przelicz ponownie
                    </button>
                  {:else}
                    <button
                      class="w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-700"
                      onclick={runCentralityAnalysis}
                      type="button"
                    >
                      Oblicz centralnosc
                    </button>
                  {/if}
                </div>

                {#if centralityResult}
                  <div class="mt-3 flex items-center gap-2 text-sm">
                    <span class="text-stone-500">Skala:</span>
                    <div class="flex flex-1 items-center gap-1">
                      <span class="h-3 w-8 rounded" style="background:#fef3c7"></span>
                      <span class="h-3 w-8 rounded" style="background:#f59e0b"></span>
                      <span class="h-3 w-8 rounded" style="background:#ef4444"></span>
                      <span class="h-3 w-8 rounded" style="background:#7f1d1d"></span>
                    </div>
                    <span class="text-stone-500">niska → wysoka</span>
                  </div>
                  <div class="mt-3 rounded-[1.25rem] border border-amber-200 bg-white px-4 py-3 text-sm leading-6 text-stone-600">
                    Aproksymacja <span class="font-semibold text-stone-900">algorytmem Brandesa</span> na probce 150 wezlow zrodlowych.
                    Wynik skalowany do pelnej sieci. Krawedzie o wynikach bliskich zeru sa ukryte.
                  </div>
                {/if}
              {:else}
                <p class="mt-3 text-sm text-stone-500">Graf niedostepny.</p>
              {/if}
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Silnik korytarzy</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    H3 + graf + Dijkstra
                  </h3>
                </div>
                <span class="rounded-full bg-sky-600 px-3 py-1 text-sm font-semibold text-white">
                  {selectedCorridorScenario()?.recommended.length ?? 0} tras
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
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Siatka H3</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Najwyżej ocenione obszary i miks vibe
                  </h3>
                </div>
                <span class="text-sm text-stone-500">klik = przyblizenie</span>
              </div>

              <div class="mt-3 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4 text-sm leading-6 text-stone-700">
                <p>
                  <span class="font-semibold text-stone-950">Wynik obszaru H3</span> to liczba 0-100 liczona z trzech rzeczy:
                  <span class="font-semibold"> popytu 45%</span>,
                  <span class="font-semibold"> obecności sieci 20%</span> i
                  <span class="font-semibold"> ogólnej jakości segmentów 35%</span>.
                </p>
                <p class="mt-2 text-xs text-stone-500">
                  `popyt` = stojaki i punkty infrastruktury po zważeniu i normalizacji, `próbki` = ile próbek segmentów co {summary.explainability.scoring.sample_step_meters} m wpada do komórki, `punkty` = ile obiektów punktowych wpada do komórki.
                </p>
              </div>

              <div class="mt-4 space-y-2">
                {#each summary.h3_grid.top_cells.slice(0, 8) as hex}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedHex?.h3_index === hex.h3_index ? 'border-blue-700 bg-blue-700 text-white shadow-lg shadow-blue-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusHex(hex)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedHex?.h3_index === hex.h3_index ? 'text-blue-100' : 'text-stone-500'}`}>
                          komórka H3 • rozdz. {hex.h3_resolution} • {hex.h3_index}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          wynik obszaru {formatScore(hex.hex_score)} • popyt {formatScore(hex.demand_score)}
                        </p>
                        <p class={`mt-1 text-xs ${selectedHex?.h3_index === hex.h3_index ? 'text-blue-100' : 'text-stone-500'}`}>
                          obiekty punktowe {formatCount(hex.point_count)} • próbki segmentów {formatCount(hex.segment_sample_count)}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedHex?.h3_index === hex.h3_index ? 'rgba(255,255,255,0.14)' : '#2563eb'}; color:#ffffff`}
                      >
                        {formatScore(hex.hex_score)}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Silnik vibe</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Kolor z miksu vibe
                  </h3>
                </div>
                <span class="text-sm text-stone-500">deterministyczny mix RGB</span>
              </div>

              <div class="mt-3 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4 text-sm leading-6 text-stone-700">
                <p>
                  Vibe to nie jest osobna warstwa z pliku. To sposób interpretacji już policzonych metryk H3. Każdy vibe bierze metryki 0-100, nadaje im wagi i liczy z nich własny wynik obszaru.
                </p>
                <p class="mt-2 text-xs text-stone-500">
                  Przykład: `Jakość powietrza (przybliżenie)` nie pochodzi z czujników powietrza. To przybliżenie liczone z zieleni i spokoju akustycznego, bo w paczce challenge nie ma osobnej warstwy jakości powietrza.
                </p>
              </div>

              <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <p class="text-sm font-semibold text-stone-950">Bazowe vibe</p>
                <div class="mt-3 space-y-3">
                  {#each mixedVibes as vibe}
                    <button
                      class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${isVibeEnabled(vibe.id) ? 'border-stone-900 bg-white shadow-sm' : 'border-stone-200 bg-stone-100 text-stone-700'}`}
                      onclick={() => toggleVibe(vibe.id)}
                      type="button"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <p class="text-sm font-semibold text-stone-950">{vibe.label}</p>
                          <p class="mt-1 text-xs leading-6 text-stone-500">{vibe.formula}</p>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="size-5 rounded-full" style={`background:${vibe.color}`}></span>
                          <span class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${isVibeEnabled(vibe.id) ? 'bg-stone-900 text-white' : 'bg-white text-stone-500 ring-1 ring-stone-200'}`}>
                            {isVibeEnabled(vibe.id) ? 'aktywny' : 'wylaczony'}
                          </span>
                        </div>
                      </div>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="mt-5 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <p class="text-sm font-semibold text-stone-950">Czyste vibe 100%</p>
                <p class="mt-1 text-xs leading-6 text-stone-500">
                  Jeden preset = jedna metryka bez domieszki innych wag. Tego samego zestawu mozna uzyc do czystych scenariuszy tras.
                </p>
                <div class="mt-3 space-y-3">
                  {#each pureMetricVibes as vibe}
                    <button
                      class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${isVibeEnabled(vibe.id) ? 'border-stone-900 bg-white shadow-sm' : 'border-stone-200 bg-stone-100 text-stone-700'}`}
                      onclick={() => toggleVibe(vibe.id)}
                      type="button"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <p class="text-sm font-semibold text-stone-950">{vibe.label}</p>
                          <p class="mt-1 text-xs leading-6 text-stone-500">{vibe.formula}</p>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="size-5 rounded-full" style={`background:${vibe.color}`}></span>
                          <span class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${isVibeEnabled(vibe.id) ? 'bg-stone-900 text-white' : 'bg-white text-stone-500 ring-1 ring-stone-200'}`}>
                            {isVibeEnabled(vibe.id) ? 'aktywny' : 'wylaczony'}
                          </span>
                        </div>
                      </div>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="mt-5 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-sm font-semibold text-stone-950">Scenariusz tras</p>
                    <p class="mt-1 text-xs leading-6 text-stone-500">
                      Zmieniaj routing między trybem zbalansowanym i czystymi trasami po jednej metryce. Każdy wariant poniżej mówi wprost, pod co optymalizuje trasę.
                    </p>
                  </div>
                  <span class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-stone-600 ring-1 ring-stone-200">
                    {corridorScenarioList().length} wariantow
                  </span>
                </div>

                <div class="mt-4 grid gap-2">
                  {#each corridorScenarioList() as scenarioItem}
                    <button
                      class={`rounded-[1.1rem] border px-4 py-3 text-left transition ${selectedCorridorScenarioId === scenarioItem.scenario.id ? 'border-sky-700 bg-sky-700 text-white shadow-lg shadow-sky-300/30' : 'border-stone-200 bg-white text-stone-800 hover:border-stone-300'}`}
                      onclick={() => selectCorridorScenario(scenarioItem.scenario.id)}
                      type="button"
                    >
                      <p class="text-sm font-semibold">{scenarioDisplayLabel(scenarioItem.scenario)}</p>
                      <p class={`mt-1 text-xs ${selectedCorridorScenarioId === scenarioItem.scenario.id ? 'text-sky-100' : 'text-stone-500'}`}>
                        {scenarioItem.recommended.length} tras • {scenarioItem.hotspots.length} hubow
                      </p>
                      <p class={`mt-1 text-xs leading-6 ${selectedCorridorScenarioId === scenarioItem.scenario.id ? 'text-sky-100' : 'text-stone-500'}`}>
                        {scenarioDisplayNote(scenarioItem.scenario, summary)}
                      </p>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="mt-5 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <p class="text-sm font-semibold text-stone-950">Dodaj wlasny vibe</p>
                    <p class="mt-1 text-xs leading-6 text-stone-500">
                      Kazda metryka jest w skali 0-100. Dodatnia waga wzmacnia metryke, ujemna odwraca ja do `100 - metric`.
                    </p>
                  </div>
                  <button
                    class="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"
                    onclick={resetCustomVibeDraft}
                    type="button"
                  >
                    reset
                  </button>
                </div>

                <div class="mt-4 grid gap-3 sm:grid-cols-2">
                  <label class="space-y-2">
                    <span class="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Nazwa</span>
                    <input bind:value={customVibeLabel} class="w-full rounded-2xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none ring-0 transition focus:border-stone-500" type="text" />
                  </label>
                  <label class="space-y-2">
                    <span class="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Kolor</span>
                    <input bind:value={customVibeColor} class="h-11 w-full rounded-2xl border border-stone-300 bg-white px-2 py-2" type="color" />
                  </label>
                </div>

                <div class="mt-4 grid gap-3 sm:grid-cols-2">
                  {#each vibeMetricMeta as metric}
                    <label class="rounded-2xl border border-stone-200 bg-white px-3 py-3">
                      <div class="flex items-center justify-between gap-3">
                        <span class="text-sm font-semibold text-stone-900">{metric.label}</span>
                        <span class="text-xs font-medium text-stone-500">{customVibeWeights[metric.key]}</span>
                      </div>
                      <p class="mt-1 text-xs leading-5 text-stone-500">{metric.note}</p>
                      {#if summary}
                        {@const doc = dataDocByCode(summary, vibeMetricDocCodeByKey[metric.key])}
                        {#if doc}
                          <p class="mt-1 text-[11px] leading-5 text-stone-500">
                            <span class="font-semibold text-stone-600">Źródło:</span> {doc.source}
                          </p>
                          <p class="mt-1 text-[11px] leading-5 text-stone-500">
                            <span class="font-semibold text-stone-600">Wzór:</span> {doc.formula}
                          </p>
                        {/if}
                      {/if}
                      <input
                        class="mt-3 w-full"
                        max="100"
                        min="-100"
                        step="5"
                        type="range"
                        value={customVibeWeights[metric.key]}
                        oninput={(event) =>
                          (customVibeWeights = {
                            ...customVibeWeights,
                            [metric.key]: Number((event.currentTarget as HTMLInputElement).value),
                          })}
                      />
                    </label>
                  {/each}
                </div>

                <div class="mt-4 flex justify-end">
                  <button
                    class="rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700"
                    onclick={addCustomVibe}
                    type="button"
                  >
                    Dodaj vibe
                  </button>
                </div>

                {#if customVibes.length > 0}
                  <div class="mt-4 space-y-3">
                    {#each customVibes as vibe}
                      <div class={`rounded-[1.25rem] border px-4 py-3 ${isVibeEnabled(vibe.id) ? 'border-violet-300 bg-white' : 'border-stone-200 bg-stone-100'}`}>
                        <div class="flex items-start justify-between gap-3">
                          <button class="min-w-0 flex-1 text-left" onclick={() => toggleVibe(vibe.id)} type="button">
                            <p class="text-sm font-semibold text-stone-950">{vibe.label}</p>
                            <p class="mt-1 text-xs leading-6 text-stone-500">{vibe.formula}</p>
                          </button>
                          <div class="flex items-center gap-2">
                            <span class="size-5 rounded-full" style={`background:${vibe.color}`}></span>
                            <span class={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${isVibeEnabled(vibe.id) ? 'bg-violet-600 text-white' : 'bg-white text-stone-500 ring-1 ring-stone-200'}`}>
                              {isVibeEnabled(vibe.id) ? 'aktywny' : 'wylaczony'}
                            </span>
                            <button
                              class="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"
                              onclick={() => removeCustomVibe(vibe.id)}
                              type="button"
                            >
                              usun
                            </button>
                          </div>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </section>

            {#if selectedHex}
              <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrana komorka H3</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedHex.h3_index}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      rozdzielczosc {selectedHex.h3_resolution}
                    </p>
                  </div>
                  <span class="rounded-full bg-blue-600 px-3 py-1 text-sm font-semibold text-white">
                    {formatScore(selectedHex.hex_score)}
                  </span>
                </div>

                <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Surowe metryki</p>
                      <h4 class="mt-1 text-base font-semibold text-stone-950">Wszystkie metryki heksa</h4>
                    </div>
                    <span class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-stone-600 ring-1 ring-stone-200">
                      surowe + znormalizowane
                    </span>
                  </div>

                  <p class="mt-3 text-xs leading-6 text-stone-500">
                    W każdym wierszu: po lewej widzisz wartość surową z danych lub agregacji, po prawej wynik po przeliczeniu do skali 0-100. Pod spodem pokazuję z jakich danych to pochodzi i jak jest liczone.
                  </p>

                  <div class="mt-4 space-y-2">
                    {#each hexMetricsRows(selectedHex) as metric}
                      <div class="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-stone-700">
                        <div class="min-w-0">
                          <p class="font-semibold text-stone-950">{metric.label}</p>
                          <p class="mt-1 text-xs text-stone-500">surowe: {metric.raw}</p>
                          {#if summary}
                            {@const doc = dataDocByCode(summary, metric.code)}
                            {#if doc}
                              <p class="mt-1 text-[11px] leading-5 text-stone-500">
                                <span class="font-semibold text-stone-600">Źródło:</span> {doc.source}
                              </p>
                              <p class="mt-1 text-[11px] leading-5 text-stone-500">
                                <span class="font-semibold text-stone-600">Wzór:</span> {doc.formula}
                              </p>
                            {/if}
                          {/if}
                        </div>
                        <span class="rounded-full bg-stone-900 px-3 py-1 text-xs font-semibold text-stone-50">
                          {metric.normalized}
                        </span>
                      </div>
                    {/each}
                  </div>
                </div>

                <div class="mt-5 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Rozbicie vibe</p>
                      <h4 class="mt-1 text-base font-semibold text-stone-950">Jak ten heks dostaje kolor</h4>
                    </div>
                    <span
                      class="size-8 rounded-full ring-2 ring-white"
                      style={`background:${analyzeHexVibes(selectedHex).color}`}
                    ></span>
                  </div>

                  <div class="mt-4 space-y-3">
                    {#each topVibesForHex(selectedHex) as vibe}
                      <div class="rounded-[1.25rem] border border-stone-200 bg-white px-4 py-3">
                        <div class="flex items-start justify-between gap-3">
                          <div>
                            <div class="flex items-center gap-2">
                              <span class="size-3 rounded-full" style={`background:${vibe.color}`}></span>
                              <p class="text-sm font-semibold text-stone-950">{vibe.label}</p>
                            </div>
                            <p class="mt-1 text-xs leading-6 text-stone-500">{vibe.formula}</p>
                          </div>
                          <span class="rounded-full px-3 py-1 text-xs font-semibold text-white" style={`background:${vibe.color}`}>
                            {formatScore(vibe.score)}
                          </span>
                        </div>
                        <div class="mt-3 grid gap-2">
                          {#each vibe.contributions as contribution}
                            <div class="flex items-center justify-between gap-3 rounded-2xl bg-stone-50 px-3 py-2 text-xs text-stone-600">
                              <span>{contribution.label}</span>
                              <span>
                                metryka {formatScore(contribution.raw)} • waga {contribution.weight > 0 ? '+' : ''}{contribution.weight}
                              </span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Korytarze</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                    Rekomendowane polaczenia dla scenariusza
                  </h3>
                </div>
                <span class="text-sm text-stone-500">klik = przyblizenie</span>
              </div>

              <p class="mt-2 text-sm text-stone-500">
                {selectedCorridorScenario()?.scenario.label ?? 'brak scenariusza'}
              </p>

              <div class="mt-4 space-y-2">
                {#each selectedCorridorScenario()?.recommended ?? [] as corridor}
                  <button
                    class={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${selectedCorridor?.corridor_id === corridor.corridor_id && selectedCorridor?.scenario_id === corridor.scenario_id ? 'border-sky-700 bg-sky-700 text-white shadow-lg shadow-sky-300/40' : 'border-stone-200 bg-stone-50 text-stone-800 hover:border-stone-300 hover:bg-white'}`}
                    onclick={() => focusCorridor(corridor)}
                    type="button"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div>
                        <p class={`text-xs font-semibold uppercase tracking-[0.2em] ${selectedCorridor?.corridor_id === corridor.corridor_id && selectedCorridor?.scenario_id === corridor.scenario_id ? 'text-sky-100' : 'text-stone-500'}`}>
                          #{corridor.corridor_rank} {corridor.from_label} -> {corridor.to_label}
                        </p>
                        <p class="mt-1 text-sm font-semibold">
                          {corridor.path_length_km.toFixed(2)} km • {corridor.segment_count} odc.
                        </p>
                        <p class={`mt-1 text-xs ${selectedCorridor?.corridor_id === corridor.corridor_id && selectedCorridor?.scenario_id === corridor.scenario_id ? 'text-sky-100' : 'text-stone-500'}`}>
                          score {formatScore(corridor.mean_segment_score)} • koszt {corridor.path_cost.toFixed(1)}
                        </p>
                      </div>
                      <span
                        class="rounded-full px-3 py-1 text-sm font-semibold"
                        style={`background:${selectedCorridor?.corridor_id === corridor.corridor_id && selectedCorridor?.scenario_id === corridor.scenario_id ? 'rgba(255,255,255,0.14)' : '#0ea5e9'}; color:#ffffff`}
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
                      Korytarz #{selectedCorridor.corridor_rank} • {scenarioDisplayLabel({
                        label: selectedCorridor.scenario_label ?? 'brak scenariusza',
                        metric_key: selectedCorridor.route_metric_key ?? null,
                      })}
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
                    <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Łączniki</p>
                    <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">
                      Propozycje nowych polaczen
                    </h3>
                  </div>
                <span class="text-sm text-stone-500">klik = przyblizenie</span>
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
                          {formatKilometers(connector.length_km)} • przeciecia {formatCount(connector.network_crossings_count)}
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
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wybrany łącznik</p>
                <div class="mt-2 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xl font-semibold tracking-tight text-stone-950">
                      {selectedConnector.label}
                    </h3>
                    <p class="mt-1 text-sm text-stone-500">
                      Łącznik #{selectedConnector.connector_rank}
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
                    <dt class="text-stone-500">Przeciecia z siecia</dt>
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
                    <dt class="text-stone-500">Zysk popytu</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.demand_gain_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Zysk sieci</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.network_gain_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Punkty za dystans</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.distance_points)}</dd>
                  </div>
                  <div class="rounded-2xl bg-stone-50 px-4 py-3">
                    <dt class="text-stone-500">Kara za przeciecia</dt>
                    <dd class="mt-1 font-semibold text-stone-950">{formatPoints(selectedConnector.crossing_penalty_points)}</dd>
                  </div>
                </dl>

                <div class="mt-5 rounded-[1.25rem] border border-red-200 bg-red-50/80 px-4 py-4">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-red-700">Co to jest łącznik?</p>
                  <p class="mt-2 text-sm leading-6 text-stone-700">
                    {summary.explainability.connector_optimization.connector_definition}
                  </p>
                  <p class="mt-2 text-sm leading-6 text-stone-700">
                    {summary.explainability.connector_optimization.why_this_is_not_guessing}
                  </p>
                </div>

                <div class="mt-4 grid gap-4 lg:grid-cols-2">
                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Na podstawie jakich danych</p>
                    <div class="mt-3 space-y-2">
                      {#each summary.explainability.connector_optimization.data_used as dataItem}
                        <div class="rounded-xl bg-white px-3 py-2 text-sm leading-6 text-stone-700 ring-1 ring-stone-200">
                          {dataItem}
                        </div>
                      {/each}
                    </div>
                  </div>

                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Dlaczego ten konkretny łącznik</p>
                    <div class="mt-3 space-y-2">
                      {#each connectorEvidenceRows(selectedConnector) as item}
                        <div class="rounded-xl bg-white px-3 py-2 ring-1 ring-stone-200">
                          <p class="text-sm font-semibold text-stone-950">{item.title}</p>
                          <p class="mt-1 text-sm leading-6 text-stone-700">{item.detail}</p>
                        </div>
                      {/each}
                    </div>
                  </div>
                </div>

                <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Jak pipeline dochodzi do łącznika</p>
                  <div class="mt-3 space-y-2">
                    {#each summary.explainability.connector_optimization.qualification_steps as step, index}
                      <div class="flex items-start gap-3 rounded-xl bg-white px-3 py-2 text-sm leading-6 text-stone-700 ring-1 ring-stone-200">
                        <span class="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-semibold text-red-700">
                          {index + 1}
                        </span>
                        <span>{step}</span>
                      </div>
                    {/each}
                  </div>
                </div>

                <div class="mt-4 rounded-[1.25rem] border border-amber-200 bg-amber-50/80 px-4 py-4">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Czy to tylko zgadywanie?</p>
                  <p class="mt-2 text-sm leading-6 text-stone-700">
                    Nie. To deterministyczny kandydat policzony z grafu istniejącej sieci i warstw przestrzennych. System nie zgaduje przebiegu z opisu ani z modelu AI, tylko bierze najkrótszą dopuszczalną parę węzłów między rozłącznymi komponentami i punktuje ją według jawnej formuły.
                  </p>
                  <p class="mt-2 text-sm leading-6 text-stone-700">
                    {summary.explainability.connector_optimization.planning_note}
                  </p>
                </div>
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Top 20</p>
                  <h3 class="mt-1 text-xl font-semibold tracking-tight text-stone-950">Najlepsze odcinki</h3>
                </div>
                <span class="text-sm text-stone-500">klik = przyblizenie</span>
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
                          #{segment.score_rank} odcinek {segment.segment_id}
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

                <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Co to jest score segmentu?</p>
                  <p class="mt-2 text-sm leading-6 text-stone-700">
                    To finalna ocena istniejącego odcinka sieci rowerowej w skali 0-100. Nie jest to liczba z pliku wejściowego, tylko wynik policzony w preprocessingu z 4 warstw danych: zieleni, hałasu, stojaków i punktowej infrastruktury rowerowej.
                  </p>
                  <div class="mt-3 grid gap-3 md:grid-cols-2">
                    <div class="rounded-2xl bg-white px-4 py-3 ring-1 ring-stone-200">
                      <p class="text-sm font-semibold text-stone-950">Wzór</p>
                      <p class="mt-2 text-xs leading-6 text-stone-600">{summary.explainability.scoring.formula}</p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3 ring-1 ring-stone-200">
                      <p class="text-sm font-semibold text-stone-950">Źródła danych</p>
                      <p class="mt-2 text-xs leading-6 text-stone-600">
                        ciągi rowerowe + zieleń BDOT10k + hałas + stojaki ZTP + infrastruktura rowerowa ZTP
                      </p>
                    </div>
                  </div>
                  <div class="mt-3 grid gap-3 md:grid-cols-3">
                    <div class="rounded-2xl bg-white px-4 py-3 ring-1 ring-stone-200">
                      <p class="text-sm font-semibold text-stone-950">Hałas</p>
                      <p class="mt-2 text-xs leading-6 text-stone-600">
                        {summary.explainability.scoring.references.noiseDb.best} dB = 100, {summary.explainability.scoring.references.noiseDb.worst} dB = 0, brak = {summary.explainability.scoring.references.noiseDb.missingScore}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3 ring-1 ring-stone-200">
                      <p class="text-sm font-semibold text-stone-950">Stojaki</p>
                      <p class="mt-2 text-xs leading-6 text-stone-600">
                        {summary.explainability.scoring.references.rackDistanceM.best} m = 100, {summary.explainability.scoring.references.rackDistanceM.worst} m = 0, brak = {summary.explainability.scoring.references.rackDistanceM.missingScore}
                      </p>
                    </div>
                    <div class="rounded-2xl bg-white px-4 py-3 ring-1 ring-stone-200">
                      <p class="text-sm font-semibold text-stone-950">Infrastruktura</p>
                      <p class="mt-2 text-xs leading-6 text-stone-600">
                        {summary.explainability.scoring.references.infrastructureDistanceM.best} m = 100, {summary.explainability.scoring.references.infrastructureDistanceM.worst} m = 0, brak = {summary.explainability.scoring.references.infrastructureDistanceM.missingScore}
                      </p>
                    </div>
                  </div>
                  <p class="mt-3 text-xs leading-6 text-stone-500">
                    Zieleń działa najprościej: <code>greenery_score = greenery_ratio * 100</code>. Sam <code>score</code> segmentu jest potem używany dalej w H3 jako wejście do <code>quality_score</code> i do rankingu odcinków.
                  </p>
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
                      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Skad ten score</p>
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
              <p class="mt-2 text-sm leading-6 text-stone-500">
                Hub H3 to punkt pokazany w środku wybranej komórki H3. Sama komórka nadal istnieje jako poligon w warstwie `Siatka H3 / vibe`, ale routing potrzebuje jednego reprezentanta komórki, więc pokazujemy też punkt.
              </p>
              <div class="mt-4 space-y-2">
                {#each selectedCorridorScenario()?.hotspots ?? [] as hotspot}
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
                        <p class="mt-1 text-xs text-stone-500">score heksa</p>
                      </div>
                    </div>
                    <p class="mt-2 text-xs text-stone-600">
                      Snap do wezla grafu: {formatDistance(hotspot.snap_distance_m)} • jakosc {formatScore(hotspot.quality_score)}
                    </p>
                  </div>
                {/each}
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Słownik danych i wzorów</p>
              <p class="mt-2 text-sm leading-6 text-stone-600">
                Każda liczba, kolor i warstwa w interfejsie ma tu opis: czym jest, z jakiego źródła pochodzi, jak jest liczona i do czego jest używana.
              </p>

              <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <p class="text-sm font-semibold text-stone-950">Legenda mapy</p>
                <div class="mt-3 rounded-[1rem] border border-blue-200 bg-blue-50 px-3 py-3 text-xs leading-6 text-blue-950">
                  <p>
                    <span class="font-semibold">Jak to czytać:</span> progi
                    <code>80-100 / 65-79 / 50-64 / 0-49</code> dotyczą tylko koloru segmentów.
                    <span class="font-semibold">Siatka H3 / vibe</span> to poligony heksów H3.
                    <span class="font-semibold">Hub H3</span> to punkt w środku wybranej komórki H3, używany jako reprezentant komórki do trasowania i jako czytelny marker na mapie.
                  </p>
                  <p class="mt-1">
                    Innymi słowy: heks = obszar, hub = punkt reprezentujący wybrany heks, korytarz = trasa po istniejącej sieci między hubami.
                  </p>
                </div>
                <div class="mt-3 space-y-2">
                  {#each mapLegendDocs(summary) as item}
                    <div class="rounded-2xl bg-white px-4 py-3 text-sm text-stone-700">
                      <div class="flex items-center justify-between gap-3">
                        <p class="font-semibold text-stone-950">{item.label}</p>
                        <span class="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                          {item.kind}
                        </span>
                      </div>
                      <div class="mt-2 grid gap-1 text-xs leading-6 text-stone-500">
                        <p><span class="font-semibold text-stone-700">Znaczenie:</span> {item.meaning}</p>
                        <p><span class="font-semibold text-stone-700">Źródło:</span> {item.source}</p>
                        <p><span class="font-semibold text-stone-700">Wzór / logika:</span> {item.formula}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>

              <div class="mt-4 space-y-4">
                {#each dataDocumentationSections(summary) as section}
                  <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                    <p class="text-sm font-semibold text-stone-950">{section.title}</p>
                    <p class="mt-1 text-xs leading-6 text-stone-500">{section.intro}</p>
                    <div class="mt-3 space-y-2">
                      {#each section.items as item}
                        <div class="rounded-2xl bg-white px-4 py-3 text-sm text-stone-700">
                          <div class="flex items-center justify-between gap-3">
                            <div class="min-w-0">
                              <p class="font-semibold text-stone-950">{item.label}</p>
                              {#if item.code}
                                <p class="mt-1 font-mono text-[11px] text-stone-500">{item.code}</p>
                              {/if}
                            </div>
                            <span class="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                              {item.valueType}
                            </span>
                          </div>
                          <div class="mt-2 grid gap-1 text-xs leading-6 text-stone-500">
                            <p><span class="font-semibold text-stone-700">Źródło:</span> {item.source}</p>
                            <p><span class="font-semibold text-stone-700">Wzór / logika:</span> {item.formula}</p>
                            <p><span class="font-semibold text-stone-700">Do czego używane:</span> {item.usage}</p>
                            {#if item.note}
                              <p><span class="font-semibold text-stone-700">Uwagi:</span> {item.note}</p>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>

              <div class="mt-4 rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-4">
                <p class="text-sm font-semibold text-stone-950">Szybki skrót metryk</p>
                <div class="mt-3 space-y-2">
                  {#each metricLegendSections as section}
                    <div class="rounded-2xl bg-white px-4 py-3 text-sm text-stone-700">
                      <p class="font-semibold text-stone-950">{section.title}</p>
                      <div class="mt-2 space-y-2">
                        {#each section.items as item}
                          <div>
                            <div class="flex items-center justify-between gap-3">
                              <p class="font-medium text-stone-900">{item.label}</p>
                              {#if item.code}
                                <span class="rounded-full bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-600">
                                  {item.code}
                                </span>
                              {/if}
                            </div>
                            <p class="mt-1 text-xs leading-6 text-stone-500">{item.note}</p>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            </section>

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Statystyki przestrzenne</p>
              <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Punkty popytu</p>
                  <p class="mt-1 text-xs text-stone-500">
                    srodek ciezkosci: {formatCoordinatePair(summary.spatial_statistics.demand_points.mean_center)}
                  </p>
                  <p class="mt-2 text-sm text-stone-700">
                    NNI {formatFixed(summary.spatial_statistics.demand_points.nearest_neighbor_index?.nni, 3)} • {summary.spatial_statistics.demand_points.nearest_neighbor_index?.pattern ?? 'brak'}
                  </p>
                </div>
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Stojaki</p>
                  <p class="mt-1 text-xs text-stone-500">
                    srodek ciezkosci: {formatCoordinatePair(summary.spatial_statistics.bike_racks.mean_center)}
                  </p>
                  <p class="mt-2 text-sm text-stone-700">
                    NNI {formatFixed(summary.spatial_statistics.bike_racks.nearest_neighbor_index?.nni, 3)} • {summary.spatial_statistics.bike_racks.nearest_neighbor_index?.pattern ?? 'brak'}
                  </p>
                </div>
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-sm font-semibold text-stone-950">Infrastruktura</p>
                  <p class="mt-1 text-xs text-stone-500">
                    srodek ciezkosci: {formatCoordinatePair(summary.spatial_statistics.bike_infrastructure.mean_center)}
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
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Wyjasnialnosc</p>
              <div class="mt-3 space-y-4 text-sm leading-7 text-stone-700">
                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Wzor</p>
                  <p class="mt-2 font-medium text-stone-950">{summary.explainability.scoring.formula}</p>
                  <p class="mt-2 text-stone-600">
                    Probkowanie: co {summary.explainability.scoring.sample_step_meters} m • zakres wyniku {summary.explainability.scoring.output_range[0]}-{summary.explainability.scoring.output_range[1]}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Indeksowanie H3</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.h3_indexing.scenario.cell_score_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    rozdzielczosc {summary.explainability.h3_indexing.scenario.resolution} • huby {summary.explainability.h3_indexing.scenario.hub_count}
                  </p>
                  <p class="mt-2 text-stone-600">
                    popyt: {summary.explainability.h3_indexing.scenario.demand_score_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    siec: {summary.explainability.h3_indexing.scenario.network_score_formula} • jakosc: {summary.explainability.h3_indexing.scenario.quality_score_formula}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Wzor vibe</p>
                  <p class="mt-2 font-medium text-stone-950">
                    vibe_score = srednia wazona metryk 0-100; dodatnia waga bierze metryke, ujemna bierze 100 - metryka
                  </p>
                  <p class="mt-2 text-stone-600">
                    Dostępne metryki: jakość powietrza (przybliżenie), zieleń otoczenia, spokój akustyczny, dostęp do stojaków, dostęp do infrastruktury, gęstość stojaków, gęstość infrastruktury, popyt, obecność sieci rowerowej, ogólna jakość segmentów.
                  </p>
                  <p class="mt-2 text-stone-600">
                    Kolor heksa = miks RGB wszystkich aktywnych vibe, wazony ich score dla danego heksa.
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Optymalizacja korytarzy</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.corridor_optimization.scenario.edge_cost_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Priorytet pary: {summary.explainability.corridor_optimization.scenario.pair_priority_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Snap grafu: {summary.explainability.corridor_optimization.graph_snap_decimals} cyfr • rozdz. H3 {summary.explainability.corridor_optimization.scenario.h3_resolution} • huby {summary.explainability.corridor_optimization.scenario.hub_count}
                  </p>
                </div>

                <div class="rounded-[1.25rem] border border-stone-200 bg-stone-50 px-4 py-3">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Optymalizacja łączników</p>
                  <p class="mt-2 font-medium text-stone-950">
                    {summary.explainability.connector_optimization.scenario.priority_formula}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Dlugosc {summary.explainability.connector_optimization.scenario.min_connector_length_meters}-{summary.explainability.connector_optimization.scenario.max_connector_length_meters} m • targety {summary.explainability.connector_optimization.scenario.target_component_limit}
                  </p>
                  <p class="mt-2 text-stone-600">
                    Metoda przeciec: {summary.explainability.connector_optimization.scenario.crossing_method}
                  </p>
                  <p class="mt-2 text-stone-600">
                    {summary.explainability.connector_optimization.connector_definition}
                  </p>
                  <p class="mt-2 text-stone-600">
                    {summary.explainability.connector_optimization.why_this_is_not_guessing}
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
            </div>
          {/if}
        </aside>
      </section>
    {/if}
  </main>
</div>
