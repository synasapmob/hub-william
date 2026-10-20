import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";

import { catalogEndpoint } from "./scripts/tailwind/vite.catalog-endpoint.ts";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const devApiTarget = loadEnv(
    mode,
    fileURLToPath(new URL(".", import.meta.url)),
    "DEV_",
  ).DEV_API_PROXY_TARGET;

  return {
    // Set by the Pages workflow to `/hub-william/` or `/hub-william/dev/`; empty
    // everywhere else. It has to match `basename` in react-router.config.ts, or
    // the router and the asset URLs disagree about where the site lives.
    base: process.env.VITE_BASE_PATH ?? "/",
    plugins: [tailwindcss(), reactRouter(), catalogEndpoint()],
    server: {
      host: "127.0.0.1",
      proxy: devApiTarget
        ? {
            "/api": {
              target: devApiTarget,
              changeOrigin: true,
              configure(proxy) {
                proxy.on("proxyReq", (proxyRequest, request) => {
                  // Only translate our own dev origin; preserve foreign origins.
                  if (
                    request.headers.origin === `http://${request.headers.host}`
                  )
                    proxyRequest.setHeader(
                      "origin",
                      new URL(devApiTarget).origin,
                    );
                });
              },
            },
          }
        : undefined,
    },
    preview: {
      host: "127.0.0.1",
    },
    resolve: {
      alias: {
        "@": new URL("./src", import.meta.url).pathname,
      },
    },
  };
});
