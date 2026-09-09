import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard is served by the reports service itself, under /admin, behind the same
// Keycloak session. Same origin means the session cookie is sent — no CORS, no token.
export default defineConfig({
  base: "/admin/",
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
  },
  server: {
    // `yarn dev` here proxies to a service running on 8081, so the dashboard
    // can be worked on against real data without building an image.
    proxy: {
      "/admin/api": {
        target: process.env.REPORTS_ORIGIN || "http://127.0.0.1:8081",
        changeOrigin: false,
      },
    },
  },
  plugins: [react()],
});
