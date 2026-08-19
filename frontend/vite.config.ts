import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Dev: forward /api to the local backend so the SPA stays same-origin.
      "/api": "http://localhost:4000",
    },
  },
  preview: {
    proxy: {
      // Preview (production build): same origin-shared /api forwarding.
      "/api": "http://localhost:4000",
    },
  },
});
