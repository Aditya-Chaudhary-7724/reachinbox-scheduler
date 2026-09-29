import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // Google profile pictures.
    remotePatterns: [{ protocol: 'https', hostname: 'lh3.googleusercontent.com' }],
  },
};

export default nextConfig;
