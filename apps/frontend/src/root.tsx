import { useState, type PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import NavigationProgress from "@/components/navigation-progress";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import assetPath from "@/utils/utils.asset-path";
import createQueryClient from "@/utils/utils.query-client";
import "../public/css/index.css";
import type { Route } from "./+types/root";

// eslint-disable-next-line react-refresh/only-export-components
export const links: Route.LinksFunction = () => [
  // Without this the browser falls back to a path-relative `/favicon.ico`,
  // which misses on every route below the root — `/tools/favicon.ico` is a
  // 404, and so is every URL under the Pages base path.
  { rel: "icon", href: assetPath("favicon.ico"), sizes: "any" },
  { rel: "apple-touch-icon", href: assetPath("apple-touch-icon.png") },
];

// eslint-disable-next-line react-refresh/only-export-components
export const meta: Route.MetaFunction = () => {
  const title = "Hub William · AI agent workspace";
  const description = `Connect shared agent accounts and configure Gateway, OpenCode and OMP with one Hub key.`;
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

export default function Root() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <NavigationProgress />

        <Outlet />

        <Toaster position="top-right" richColors />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
