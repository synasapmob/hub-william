import type { PropsWithChildren } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles/root/root-index.css";

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          name="description"
          content="A modular workspace and deterministic runtime for engineering agents — harnesses, skills, hooks, and live activity observation."
        />
        <meta name="theme-color" content="#fafbfc" />
        {/* Base-aware: on GitHub Pages the site lives under `/hub-william/`,
            and an absolute `/favicon.svg` resolves to the domain root, which
            is somebody else's 404. */}
        <link
          rel="icon"
          type="image/svg+xml"
          href={`${import.meta.env.BASE_URL}favicon.svg`}
        />
        <title>Hub William · AI agent workspace</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * No providers beyond the ones the UI itself needs.
 *
 * Nothing in the workspace is fetched: the catalogue is Markdown inlined at
 * build time and the telemetry is fixture data, so there is no query client to
 * hold and no hydration gap to cover with a loading screen.
 */
export default function Root() {
  return (
    <TooltipProvider>
      <Outlet />
      <Toaster position="top-right" richColors />
    </TooltipProvider>
  );
}
