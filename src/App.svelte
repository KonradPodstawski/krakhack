<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { Map as MapLibreMap, MapGeoJSONFeature, Popup as MapLibrePopup } from 'maplibre-gl'
  import {
    KRAKOW_CENTER,
    MAP_STYLE,
    formatDistance,
    formatKilometers,
    formatNoise,
    formatPercent,
    formatScore,
    scoreColor,
    type Summary,
    type TopSegment,
  } from './lib/smart-city'

  const SUMMARY_URL = '/generated/cycling-smart-city/summary.json'
  const SEGMENTS_URL = '/generated/cycling-smart-city/segments.geojson'
  const POINTS_URL = '/generated/cycling-smart-city/points.geojson'

  let mapContainer: HTMLDivElement
  let maplibreModule: typeof import('maplibre-gl') | null = null
  let map: MapLibreMap | null = null
  let popup: MapLibrePopup | null = null

  let summary: Summary | null = null
  let selectedSegment: TopSegment | null = null
  let error: string | null = null
  let isLoading = true
  let isMapReady = false

  let showRacks = true
  let showInfrastructure = true
  let onlyTopSegments = false

  const scoreLegend = [
    { label: '80-100', color: '#166534' },
    { label: '65-79', color: '#65a30d' },
    { label: '50-64', color: '#d97706' },
    { label: '0-49', color: '#b91c1c' },
  ]

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

  $: syncPointVisibility()
  $: syncSegmentFilter()
  $: syncSelectedSegment()

  async function initialize() {
    isLoading = true
    isMapReady = false
    error = null

    try {
      summary = await fetchJson<Summary>(SUMMARY_URL)
      selectedSegment = summary.top_segments[0] ?? null

      maplibreModule = await import('maplibre-gl')

      map = new maplibreModule.Map({
        container: mapContainer,
        style: MAP_STYLE,
        attributionControl: false,
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
        syncPointVisibility()
        syncSegmentFilter()
        syncSelectedSegment()
        resetView()

        isLoading = false
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Nie udało sie wczytac danych.'
      isLoading = false
    }
  }

  function addSources(currentMap: MapLibreMap) {
    currentMap.addSource('segments', {
      type: 'geojson',
      data: SEGMENTS_URL,
      lineMetrics: true,
    })

    currentMap.addSource('points', {
      type: 'geojson',
      data: POINTS_URL,
    })
  }

  function addLayers(currentMap: MapLibreMap) {
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
          '#b91c1c',
          50,
          '#d97706',
          65,
          '#65a30d',
          80,
          '#166534',
        ],
        'line-opacity': 0.82,
        'line-width': [
          'interpolate',
          ['linear'],
          ['coalesce', ['get', 'score'], 0],
          0,
          1.4,
          100,
          4.8,
        ],
      },
    })

    currentMap.addLayer({
      id: 'segments-top-casing',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'is_top_segment'], true],
      paint: {
        'line-color': '#111827',
        'line-opacity': 0.9,
        'line-width': 8,
      },
    })

    currentMap.addLayer({
      id: 'segments-top-fill',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'is_top_segment'], true],
      paint: {
        'line-color': '#f59e0b',
        'line-opacity': 0.95,
        'line-width': 5,
      },
    })

    currentMap.addLayer({
      id: 'segments-selected',
      type: 'line',
      source: 'segments',
      filter: ['==', ['get', 'segment_id'], -1],
      paint: {
        'line-color': '#2563eb',
        'line-opacity': 1,
        'line-width': 7,
      },
    })

    currentMap.addLayer({
      id: 'points-racks',
      type: 'circle',
      source: 'points',
      filter: ['==', ['get', 'point_kind'], 'rack'],
      paint: {
        'circle-color': '#14532d',
        'circle-radius': 4.5,
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': 1.2,
      },
    })

    currentMap.addLayer({
      id: 'points-infrastructure',
      type: 'circle',
      source: 'points',
      filter: ['==', ['get', 'point_kind'], 'infrastructure'],
      paint: {
        'circle-color': '#7c3aed',
        'circle-radius': 5,
        'circle-stroke-color': '#f8fafc',
        'circle-stroke-width': 1.2,
      },
    })
  }

  function bindMapEvents(currentMap: MapLibreMap) {
    for (const layerId of ['segments-base', 'segments-top-fill', 'points-racks', 'points-infrastructure']) {
      currentMap.on('mouseenter', layerId, () => {
        currentMap.getCanvas().style.cursor = 'pointer'
      })
      currentMap.on('mouseleave', layerId, () => {
        currentMap.getCanvas().style.cursor = ''
      })
    }

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
      kind: toNullableString(properties.kind),
      length_km: toNumber(properties.length_km),
      max_noise_db: toNullableNumber(properties.max_noise_db),
      nearest_infra_m: toNullableNumber(properties.nearest_infra_m),
      nearest_rack_m: toNullableNumber(properties.nearest_rack_m),
      score: toNumber(properties.score),
      score_rank: toNullableNumber(properties.score_rank),
      segment_id: toNumber(properties.segment_id),
      surface: toNullableString(properties.surface),
    }
  }

  function buildSegmentPopup(segment: TopSegment) {
    return `
      <div class="w-[18rem] bg-white p-4 text-stone-900">
        <div class="mb-3 flex items-start justify-between gap-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Segment #${segment.segment_id}</p>
            <h3 class="mt-1 text-lg font-semibold text-stone-950">${escapeHtml(segment.kind ?? 'nieopisany odcinek')}</h3>
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
                  Segmenty po score + punkty infrastruktury
                </h2>
              </div>

              <div class="flex flex-wrap gap-2">
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showRacks ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showRacks} class="sr-only" type="checkbox" />
                  <span>Stojaki</span>
                </label>
                <label class={`inline-flex cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${showInfrastructure ? 'bg-stone-900 text-stone-50' : 'bg-stone-100 text-stone-700'}`}>
                  <input bind:checked={showInfrastructure} class="sr-only" type="checkbox" />
                  <span>Punkty</span>
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
                      Segment #{selectedSegment.segment_id}
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
              </section>
            {/if}

            <section class="rounded-[1.5rem] border border-stone-300 bg-white/82 p-5 shadow-lg shadow-amber-100/50 backdrop-blur">
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Metoda</p>
              <div class="mt-3 space-y-3 text-sm leading-7 text-stone-700">
                <p>Score to heurystyka: premia za kontakt z zielenią i kara za halas oraz odleglosc od stojakow i punktow infrastruktury. Zielen i halas sa liczone przez deterministyczne probkowanie linii co staly krok.</p>
                <p>Surowe poligony zieleni i halasu nie sa renderowane na mapie, bo bylyby zbyt ciezkie dla frontendu. Ich wplyw jest baked-in w wynik segmentu.</p>
              </div>
            </section>
          {/if}
        </aside>
      </section>
    {/if}
  </main>
</div>
