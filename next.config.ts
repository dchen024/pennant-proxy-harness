import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Memory page reads the casebook from disk at request time; ship it with that route.
  outputFileTracingIncludes: { "/memory": ["./data/casebook.json"] },
};

export default nextConfig;
