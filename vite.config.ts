import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:18800",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:18800",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
  test: {
    // Gateway tests run in Node (no DOM needed)
    // UI tests run in jsdom (simulated browser)
    environment: "jsdom",
    // Include both test directories
    include: ["tests/**/*.test.ts"],
  },
});
