import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // TMDB image paths are size-templated (e.g. /t/p/w342/<hash>.jpg) — the
    // wildcard covers every size string lib/content/tmdb/normalize.ts might
    // request without needing a config change every time that map grows.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
};

export default nextConfig;
