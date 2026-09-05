// Ambient declarations for the two npm modules the article extractor imports.
//
// Same reason as deno.d.ts: `pnpm typecheck:functions` runs tsc over this
// folder, and tsc cannot resolve a `npm:` specifier. Supabase bundles these at
// deploy time, so nothing here reaches the runtime.
//
// Declared rather than installed. Adding linkedom and readability to
// package.json would put two megabytes of DOM shim in the web app's dependency
// tree to satisfy a type checker that never runs them, and the surface used is
// three functions wide.
//
// Both were verified against the real modules under Deno 2.9.5: linkedom parses
// a 201 kB article in 7 ms, and Readability drives off its document without
// complaint. deno-dom also works — it ships WASM by default, so it needs no FFI
// — but its DOM coverage is partial and Readability touches a wide surface, so
// linkedom is the safer half of that pair.

declare module "npm:linkedom@0.18.13" {
  export function parseHTML(html: string): {
    document: Document;
    window: Window;
  };
}

declare module "npm:@mozilla/readability@0.6.0" {
  export interface ReadabilityResult {
    title: string | null;
    byline: string | null;
    content: string | null;
    textContent: string | null;
    length: number;
    excerpt: string | null;
    siteName: string | null;
  }

  export class Readability {
    constructor(document: Document, options?: Record<string, unknown>);
    parse(): ReadabilityResult | null;
  }

  export function isProbablyReaderable(
    document: Document,
    options?: Record<string, unknown>,
  ): boolean;
}
