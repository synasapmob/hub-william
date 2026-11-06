import { useState, type PropsWithChildren } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import createQueryClient from "@/utils/utils.query-client";
import "../public/css/index.css";
import type { Route } from "./+types/root";

// eslint-disable-next-line react-refresh/only-export-components
export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

// eslint-disable-next-line react-refresh/only-export-components
export const meta: Route.MetaFunction = () => [
  { title: "Hub William · Dashboard" },
  {
    name: "description",
    content:
      "Bán hàng, kho, đơn hàng và doanh thu của Hub William và Telegram shop.",
  },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
  { charSet: "utf-8" },
];

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang="vi">
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
        <Outlet />

        <Toaster position="top-right" richColors />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
