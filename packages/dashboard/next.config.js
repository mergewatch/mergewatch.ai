const path = require('path');

/**
 * Content-Security-Policy starts in report-only mode. Violations will
 * surface in browser devtools without blocking anything, so we can
 * measure real-world breakage before flipping to enforcement. Inline
 * scripts are needed for JSON-LD blocks and the Next.js theme
 * detection script, so 'unsafe-inline' is scoped to script-src for now.
 */
const cspReportOnly = [
  "default-src 'self'",
  // Google Analytics gtag loads from googletagmanager.com.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  // GA tracking pixels are served from google-analytics.com / analytics.google.com.
  "img-src 'self' data: https://avatars.githubusercontent.com https://www.google-analytics.com https://*.analytics.google.com",
  "font-src 'self' data:",
  // GA collect endpoint + Region 1 endpoints used for measurement transport.
  "connect-src 'self' https://api.github.com https://www.google-analytics.com https://*.analytics.google.com https://*.google-analytics.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ');

/**
 * Security headers applied to every response. HSTS and the nosniff/frame/
 * referrer policies are safe universal defaults. CSP ships in report-only
 * mode; promote to enforcing (Content-Security-Policy) after a week of
 * monitoring browser reports.
 */
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  {
    key: 'Content-Security-Policy-Report-Only',
    value: cspReportOnly,
  },
];

// Public marketing pages — safe to cache aggressively at the CDN edge.
const publicCacheControl = {
  key: 'Cache-Control',
  value: 'public, s-maxage=300, stale-while-revalidate=86400',
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  // 'standalone' output bundles the server into a self-contained directory.
  // Required for AWS Amplify SSR hosting — Amplify deploys the .next/standalone
  // output as Lambda@Edge functions.
  output: 'standalone',

  // Strip the X-Powered-By: Next.js fingerprint header.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Apply the security headers to every route.
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/',
        headers: [publicCacheControl],
      },
      {
        source: '/pricing',
        headers: [publicCacheControl],
      },
      {
        source: '/about',
        headers: [publicCacheControl],
      },
      {
        source: '/privacy',
        headers: [publicCacheControl],
      },
      {
        source: '/terms',
        headers: [publicCacheControl],
      },
    ];
  },

  // Expose env vars to the server runtime (Amplify SSR only gets build-time
  // env vars by default — this ensures they're bundled into the runtime).
  env: {
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    DYNAMODB_TABLE_INSTALLATIONS: process.env.DYNAMODB_TABLE_INSTALLATIONS,
    DYNAMODB_TABLE_REVIEWS: process.env.DYNAMODB_TABLE_REVIEWS,
    // FB-F..FB-J — optional; routes degrade to a zero-state when unset.
    DYNAMODB_TABLE_FP_INSIGHTS: process.env.DYNAMODB_TABLE_FP_INSIGHTS,
    API_KEYS_TABLE: process.env.API_KEYS_TABLE,
    GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
    DEPLOYMENT_MODE: process.env.DEPLOYMENT_MODE,
    BILLING_API_URL: process.env.BILLING_API_URL,
    BILLING_API_SECRET: process.env.BILLING_API_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_GA_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
  },

  // Prevent Next.js from bundling native modules used by storage packages.
  // These are loaded at runtime via dynamic import() in lib/store.ts.
  experimental: {
    // Trace files from the monorepo root so pnpm-hoisted node_modules are
    // correctly resolved in the standalone output.
    outputFileTracingRoot: path.join(__dirname, '../../'),
    serverComponentsExternalPackages: [
      '@aws-sdk/client-dynamodb',
      '@aws-sdk/lib-dynamodb',
      'postgres',
    ],
    // Cache visited dynamic pages on the client for 60s so fast tab-switching
    // serves stale content instantly (revalidates in background on next nav).
    staleTimes: {
      dynamic: 60,
    },
  },
};

module.exports = nextConfig;
