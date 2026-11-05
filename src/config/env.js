'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Parse a comma-separated list into a trimmed array.
 * @param {string} value
 * @returns {string[]}
 */
function parseList(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse a comma-separated list of origins into a trimmed array.
 * @param {string} value
 * @returns {string[]}
 */
function parseOrigins(value) {
  return parseList(value);
}

/**
 * Normalize host allowlist entries to lowercase hostname[:port].
 * Accepts bare hosts or full origins/URLs.
 * @param {string[]} entries
 * @returns {string[]}
 */
function normalizeHosts(entries) {
  const hosts = new Set();
  for (const entry of entries) {
    try {
      if (entry.includes('://')) {
        hosts.add(new URL(entry).host.toLowerCase());
      } else {
        hosts.add(entry.toLowerCase().replace(/\/+$/, ''));
      }
    } catch {
      // skip invalid entries
    }
  }
  return [...hosts];
}

/**
 * Parse optional JSON object for extra upstream headers.
 * @param {string} value
 * @returns {Record<string, string>}
 */
function parseExtraHeaders(value) {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const headers = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === 'string') {
          headers[key] = val;
        }
      }
      return headers;
    }
  } catch {
    throw new Error('VIDEO_PROVIDER_EXTRA_HEADERS must be valid JSON object');
  }
  throw new Error('VIDEO_PROVIDER_EXTRA_HEADERS must be a JSON object');
}

const AUTH_TYPES = new Set(['bearer', 'header', 'query', 'signed-url']);
const URL_PROXY_MODES = new Set(['allowlist', 'any']);

/**
 * Load and validate environment configuration.
 * Throws early if required production settings are missing.
 */
function loadEnv() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const upstreamTimeout = Number.parseInt(process.env.UPSTREAM_TIMEOUT || '30000', 10);
  const rateLimitWindowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
  const rateLimitMax = Number.parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
  const authType = (process.env.VIDEO_PROVIDER_AUTH_TYPE || 'bearer').toLowerCase();
  const urlProxyMode = (process.env.URL_PROXY_MODE || 'allowlist').toLowerCase();

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port number');
  }
  const minUpstreamTimeout = nodeEnv === 'test' ? 50 : 1000;
  if (!Number.isFinite(upstreamTimeout) || upstreamTimeout < minUpstreamTimeout) {
    throw new Error(`UPSTREAM_TIMEOUT must be at least ${minUpstreamTimeout} ms`);
  }
  if (!AUTH_TYPES.has(authType)) {
    throw new Error(
      `VIDEO_PROVIDER_AUTH_TYPE must be one of: ${[...AUTH_TYPES].join(', ')}`
    );
  }
  if (!URL_PROXY_MODES.has(urlProxyMode)) {
    throw new Error(
      `URL_PROXY_MODE must be one of: ${[...URL_PROXY_MODES].join(', ')}`
    );
  }

  const baseUrl = (process.env.VIDEO_PROVIDER_BASE_URL || '').replace(/\/+$/, '');
  let providerHost = '';
  if (baseUrl) {
    try {
      providerHost = new URL(baseUrl).host.toLowerCase();
    } catch {
      throw new Error('VIDEO_PROVIDER_BASE_URL must be a valid absolute URL');
    }
  }

  const allowedUpstreamHosts = normalizeHosts([
    ...parseList(process.env.ALLOWED_UPSTREAM_HOSTS || ''),
    ...(providerHost ? [providerHost] : []),
  ]);

  const referer = (process.env.VIDEO_PROVIDER_REFERER || '').trim();
  if (referer) {
    try {
      const parsedReferer = new URL(referer);
      if (!['http:', 'https:'].includes(parsedReferer.protocol)) {
        throw new Error('invalid protocol');
      }
    } catch {
      throw new Error('VIDEO_PROVIDER_REFERER must be a valid http(s) URL');
    }
  }

  const proxyApiKey = process.env.PROXY_API_KEY || '';

  const config = {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    port,
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || ''),
    /**
     * allowlist — only hosts in ALLOWED_UPSTREAM_HOSTS / BASE_URL
     * any — any public http(s) host (requires PROXY_API_KEY; SSRF-blocked)
     */
    urlProxyMode,
    allowedUpstreamHosts,
    videoProvider: {
      baseUrl,
      token: process.env.VIDEO_PROVIDER_TOKEN || '',
      authType,
      authHeader: process.env.VIDEO_PROVIDER_AUTH_HEADER || 'X-Api-Key',
      authQueryParam: process.env.VIDEO_PROVIDER_AUTH_QUERY_PARAM || 'token',
      pathTemplate: process.env.VIDEO_PROVIDER_PATH_TEMPLATE || '/videos/{videoId}',
      referer,
      extraHeaders: parseExtraHeaders(process.env.VIDEO_PROVIDER_EXTRA_HEADERS || ''),
      timeoutMs: upstreamTimeout,
    },
    proxyApiKey,
    rateLimit: {
      windowMs: rateLimitWindowMs,
      max: rateLimitMax,
    },
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  if (
    config.videoProvider.baseUrl &&
    !config.videoProvider.pathTemplate.includes('{videoId}')
  ) {
    throw new Error('VIDEO_PROVIDER_PATH_TEMPLATE must include {videoId}');
  }

  // Authenticated multi-host URL mode always needs a proxy API key
  if (urlProxyMode === 'any' && (!proxyApiKey || proxyApiKey.length < 16)) {
    throw new Error(
      'URL_PROXY_MODE=any requires PROXY_API_KEY (min 16 characters) so the endpoint is not an open proxy'
    );
  }

  if (urlProxyMode === 'allowlist') {
    if (!config.videoProvider.baseUrl && config.allowedUpstreamHosts.length === 0) {
      throw new Error(
        'URL_PROXY_MODE=allowlist requires VIDEO_PROVIDER_BASE_URL and/or ALLOWED_UPSTREAM_HOSTS'
      );
    }
  }

  if (config.isProduction) {
    if (!config.proxyApiKey || config.proxyApiKey.length < 16) {
      throw new Error('PROXY_API_KEY must be set to a strong secret in production');
    }
    if (config.videoProvider.baseUrl && !config.videoProvider.token) {
      throw new Error('VIDEO_PROVIDER_TOKEN is required in production when using BASE_URL');
    }
    if (config.allowedOrigins.length === 0) {
      throw new Error('ALLOWED_ORIGINS must include at least one origin in production');
    }
  }

  return Object.freeze(config);
}

let cachedConfig = null;

/**
 * @returns {ReturnType<typeof loadEnv>}
 */
function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadEnv();
  }
  return cachedConfig;
}

/**
 * Reset cached config (used by tests).
 */
function resetConfig() {
  cachedConfig = null;
}

module.exports = {
  getConfig,
  resetConfig,
  loadEnv,
  URL_PROXY_MODES,
};
