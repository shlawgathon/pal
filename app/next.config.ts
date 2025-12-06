import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    allowedDevOrigins: ['pal.liftgate.io'],
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
