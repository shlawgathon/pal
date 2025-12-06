import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "pal.images.growly.gg",
            },
        ],
    },
};

export default nextConfig;
