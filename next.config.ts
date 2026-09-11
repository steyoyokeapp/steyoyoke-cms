import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_STANDALONE_OUTPUT === "true"
    ? { output: "standalone" as const }
    : {}),
  poweredByHeader: false,
};

export default nextConfig;
