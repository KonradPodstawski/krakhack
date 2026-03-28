<script lang="ts">
  const stack = ['Svelte 5', 'TypeScript', 'Tailwind CSS 4', 'Vite 8'] as const
  const commands = ['nvm use', 'npm ci', 'npm run dev'] as const
</script>

<svelte:head>
  <title>krakhack</title>
  <meta
    name="description"
    content="Starter projektu Svelte + TypeScript + Tailwind CSS."
  />
</svelte:head>

<div
  class="min-h-screen bg-[radial-gradient(circle_at_top,_#fef3c7,_#fff7ed_36%,_#fafaf9_72%)] text-stone-950"
>
  <main
    class="mx-auto flex min-h-screen max-w-6xl flex-col justify-center gap-10 px-6 py-16 sm:px-10 lg:px-12"
  >
    <section
      class="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(22rem,1fr)] lg:items-start"
    >
      <div class="space-y-6">
        <span
          class="inline-flex w-fit items-center rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-amber-950"
        >
          Starter ready
        </span>

        <div class="space-y-4">
          <p class="text-sm font-medium uppercase tracking-[0.3em] text-stone-500">
            krakhack
          </p>
          <h1
            class="max-w-3xl font-serif text-5xl leading-tight tracking-tight text-stone-950 sm:text-6xl"
          >
            Svelte, TypeScript i Tailwind sa juz spiete w minimalny, czysty setup.
          </h1>
          <p class="max-w-2xl text-base leading-8 text-stone-700 sm:text-lg">
            Bez dodatkowego routera, bez PostCSS i bez nadmiarowego boilerplate'u. Masz
            gotowy punkt startowy oparty o Vite, z przypietym toolchainem i lockfile.
          </p>
        </div>

        <div class="flex flex-wrap gap-3">
          {#each stack as item}
            <span
              class="rounded-full border border-stone-300 bg-white/80 px-4 py-2 text-sm font-medium text-stone-700 shadow-sm shadow-stone-200/60 backdrop-blur"
            >
              {item}
            </span>
          {/each}
        </div>
      </div>

      <aside
        class="rounded-[2rem] border border-stone-300 bg-white/85 p-6 shadow-xl shadow-amber-100/70 backdrop-blur sm:p-8"
      >
        <div class="space-y-6">
          <div class="space-y-2">
            <p class="text-sm font-semibold uppercase tracking-[0.24em] text-stone-500">
              Start
            </p>
            <h2 class="text-2xl font-semibold tracking-tight text-stone-950">
              Deterministyczny workflow
            </h2>
          </div>

          <ol class="space-y-3">
            {#each commands as command, index}
              <li
                class="flex items-center gap-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3"
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-stone-50"
                >
                  {index + 1}
                </span>
                <code class="text-sm font-medium text-stone-800">{command}</code>
              </li>
            {/each}
          </ol>

          <p class="text-sm leading-7 text-stone-600">
            Edytuj <code class="rounded bg-stone-100 px-2 py-1 text-stone-800">src/App.svelte</code>
            i buduj dalej na prostym fundamencie.
          </p>
        </div>
      </aside>
    </section>
  </main>
</div>
