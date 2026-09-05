import { defineConfig } from "vite";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  // Set by the Pages workflow to `/hub-william/` or `/hub-william/dev/`; empty
  // everywhere else. It has to match `basename` in react-router.config.ts, or
  // the router and the asset URLs disagree about where the site lives.
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
