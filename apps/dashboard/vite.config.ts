import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  server: {
    host: "127.0.0.1",
    // The storefront (`apps/frontend`) takes Vite's default port.
    port: 5174,
  },
  preview: {
    host: "127.0.0.1",
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
