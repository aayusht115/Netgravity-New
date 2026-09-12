import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  rewrites() {
    return {
      beforeFiles: [
        {
          source: "/",
          destination: "/netgravity.html"
        }
      ]
    };
  }
};

export default nextConfig;
