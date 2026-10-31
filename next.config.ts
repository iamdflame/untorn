import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // sharp is native; heic-decode ships a large wasm decoder (libheif-js): load both from node_modules at runtime.
  serverExternalPackages: ["sharp", "heic-decode"],
  // The sample photo and its answer key are read from disk by the run and health routes.
  outputFileTracingIncludes: {
    "/api/runs": ["./data/samples/**/*"],
    "/api/health/run": ["./data/samples/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
