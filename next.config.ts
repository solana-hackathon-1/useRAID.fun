import type { NextConfig } from 'next';
import { IMAGE_HOSTS } from './src/lib/image-hosts';

const dev = process.env.NODE_ENV !== 'production';
// Next injects inline bootstrap scripts, and there is no nonce, so scripts need 'unsafe-inline'.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${IMAGE_HOSTS.map((h) => `https://${h}`).join(' ')}`,
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const config: NextConfig = {
  distDir: ['.next-studio', '.next-db-down', '.next-meteora'].includes(
    process.env.NEXT_DIST_DIR ?? '',
  )
    ? process.env.NEXT_DIST_DIR
    : '.next',
  devIndicators: false,
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // OAuth callback URLs contain short-lived authorization codes and must not be logged.
  logging: { incomingRequests: { ignore: [/\/api\/auth(?:\/|\?|$)/] } },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          ...(dev
            ? []
            : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
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
