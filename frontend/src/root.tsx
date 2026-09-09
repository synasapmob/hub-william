import type { PropsWithChildren } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import assetPath from "@/utils/utils.asset-path";
import "../public/css/index.css";
import type { Route } from "./+types/root";

// eslint-disable-next-line react-refresh/only-export-components
export const links: Route.LinksFunction = () => [
  // Without this the browser falls back to a path-relative `/favicon.ico`,
  // which misses on every route below the root — `/library/favicon.ico` is a
  // 404, and so is every URL under the Pages base path.
  { rel: "icon", href: assetPath("favicon.ico"), sizes: "any" },
  { rel: "apple-touch-icon", href: assetPath("apple-touch-icon.png") },
];

// eslint-disable-next-line react-refresh/only-export-components
export const meta: Route.MetaFunction = () => {
  const title = "Hub William · AI agent workspace";
  const description = `A modular workspace and deterministic runtime for engineering agents — harnesses, skills, hooks, and live activity observation.`;
  const imageUrl = `https://res.cloudinary.com/synasapmob/image/upload/v1788697028/3039cfe2d23a5f062d0962c900684368.jpg`;

  return [
    { title },
    { name: "description", content: description },
    // `viewport-fit=cover` is what makes the `safe-area-inset-*` values
    // resolve to anything but zero, which the iOS shell relies on to stay
    // clear of the notch and the home indicator.
    {
      name: "viewport",
      content:
        "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
    },
    { charSet: "utf-8" },

    // Open Graph / Facebook / Slack / Discord
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: imageUrl },

    // Twitter Card
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: imageUrl },
  ];
};

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
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
