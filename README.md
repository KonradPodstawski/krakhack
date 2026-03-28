# krakhack

Svelte + TypeScript + Tailwind CSS + MapLibre, z preprocessingiem danych challenge w Node.

## Wymagania

- Node `24.3.0` z pliku `.nvmrc`
- npm `11.6.2`

## Start

```bash
nvm use
npm ci
npm run prepare:cycling-data
npm run dev
```

## Skrypty

```bash
npm run prepare:cycling-data
npm run dev
npm run check
npm run build
npm run preview
```

## Co robi preprocessing

- czyta `Smart Infrastructure Challenge/cycling-smart-city/data.zip`
- normalizuje CRS do WGS84
- scala punkty, sciezki, zielen i halas
- liczy score dla kazdego segmentu sciezki
- zapisuje gotowe artefakty do `public/generated/cycling-smart-city`

## Deterministycznosc

- wersje narzedzi sa przypiete przez `.nvmrc` i `packageManager`
- zaleznosci sa przypiete do exact versions
- frontend nie zalezy od zewnetrznego basemapu ani runtime API
- powtarzalna instalacja i uruchomienie powinny isc przez `npm ci` oraz `npm run prepare:cycling-data`
