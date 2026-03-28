# krakhack

Minimalny starter `Svelte + TypeScript + Tailwind CSS + Vite`, ustawiony pod mozliwie
powtarzalny lokalny development.

## Wymagania

- Node `24.3.0` z pliku `.nvmrc`
- npm `11.6.2`

## Start

```bash
nvm use
npm ci
npm run dev
```

## Skrypty

```bash
npm run dev
npm run check
npm run build
npm run preview
```

## Deterministycznosc

- wersje narzedzi sa przypiete przez `.nvmrc` i `packageManager`
- zaleznosci sa przypiete do exact versions
- powtarzalna instalacja powinna isc przez `npm ci`
- Tailwind dziala przez plugin Vite, bez dodatkowego `postcss.config`
