import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const devProxyTarget = process.env["VITE_DEV_PROXY_TARGET"] || "http://127.0.0.1:3000";
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "font-src 'self' data: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  server: {
    port: 5173,
    headers: {
      "Content-Security-Policy": contentSecurityPolicy,
    },
    proxy: {
      "/api": devProxyTarget,
      "/_": devProxyTarget,
    },
  },
});
