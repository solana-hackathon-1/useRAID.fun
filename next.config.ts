import type { NextConfig } from 'next';
const config: NextConfig = {
  distDir: ['.next-studio','.next-meteora'].includes(process.env.NEXT_DIST_DIR || '') ? process.env.NEXT_DIST_DIR : '.next',
  devIndicators: false,
  allowedDevOrigins: ['192.168.101.3'],
  // OAuth callback URLs contain short-lived authorization codes and must not be logged.
  logging: { incomingRequests: { ignore: [/\/api\/auth(?:\/|\?|$)/] } },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
