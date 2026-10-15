import type { NextConfig } from "next";

const desktop = process.env.YINCHA_DESKTOP === "1";

const nextConfig: NextConfig = {
  ...(desktop
    ? { output: "export" as const, distDir: ".next-desktop" }
    : { cacheComponents: true, partialPrefetching: true }),
  // The dev server listens on 0.0.0.0, so a browser at 127.0.0.1 is treated as
  // cross-origin and its module scripts are rejected. Without this, clicks do nothing.
  allowedDevOrigins: ["127.0.0.1"],
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
