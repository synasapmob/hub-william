import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    env: { VITE_API_BASE_URL: "http://localhost:8080" },
    environment: "jsdom",
    fileParallelism: false,
    setupFiles: ["./src/test/setup.ts"],
  },
});
