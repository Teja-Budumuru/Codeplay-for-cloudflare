import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // allow importing files outside the `apps/web` directory (monorepo support)
  experimental: { externalDir: true },
  turbopack: {
    resolveAlias: {
      "@packages": path.resolve(__dirname, "../../packages"),
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@packages": path.resolve(__dirname, "../../packages"),
    };
    return config;
  },
};

export default nextConfig;
