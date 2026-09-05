// Ambient declarations for the two Deno APIs these Edge Functions use.
//
// Why this exists: no tsconfig in the repo includes `supabase/`, so an editor's
// TypeScript server treats these files as an inferred project with browser libs
// and reports `Cannot find name 'Deno'` (TS2304). The Deno extension would
// supply the real types, but this keeps the folder clean for anyone without it.
//
// Deliberately minimal — if a function starts using more of the Deno API,
// install the Deno extension rather than growing this file into a fake runtime.

declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
    toObject(): Record<string, string>;
  };

  function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;

  function serve(
    options: { port?: number; hostname?: string },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
}
