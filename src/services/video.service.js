'use strict';

const { Readable } = require('stream');
const net = require('net');
const dns = require('dns').promises;
const { getConfig } = require('../config/env');
const { AppError } = require('../middleware/error.middleware');
const { logger } = require('../utils/logger');
const {
  isHlsPlaylist,
  readPlaylistText,
  rewriteHlsPlaylist,
} = require('./hls.service');

const MAX_UPSTREAM_URL_LENGTH = 2048;

/** Hostnames that must never be proxied (SSRF / internal). */
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.corp',
  '.home',
  '.lan',
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/**
 * Build the upstream URL for a given video ID.
 * Never accepts an arbitrary client-supplied URL.
 * @param {string} videoId
 * @returns {string}
 */
function buildUpstreamUrl(videoId) {
  const config = getConfig();
  const { baseUrl, pathTemplate, authType, authQueryParam, token } = config.videoProvider;

  if (!baseUrl) {
    throw new AppError(
      'VIDEO_PROVIDER_BASE_URL is not configured for ID-based streaming',
      500,
      'UPSTREAM_CONFIG_ERROR'
    );
  }

  const encodedId = encodeURIComponent(videoId);
  const path = pathTemplate.replace(/\{videoId\}/g, encodedId);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);

  // Ensure resolved URL stays under the configured base host (no open proxy)
  if (url.origin !== new URL(baseUrl).origin) {
    throw new AppError('Invalid upstream URL resolution', 500, 'UPSTREAM_CONFIG_ERROR');
  }

  if (authType === 'query' && token) {
    url.searchParams.set(authQueryParam, token);
  }

  return url.toString();
}

/**
 * True if hostname is a literal IP that is loopback/private/link-local/metadata.
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedIpLiteral(hostname) {
  const ip = hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(ip)) {
    return false;
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80')) return true; // link-local
  return false;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate a client-supplied upstream URL (sync checks).
 * In allowlist mode, host must be listed. In any mode, public hosts are allowed.
 * @param {string} rawUrl
 * @returns {URL}
 */
function validateClientUpstreamUrl(rawUrl) {
  const config = getConfig();

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new AppError('url query parameter is required', 400, 'INVALID_UPSTREAM_URL');
  }

  if (rawUrl.length > MAX_UPSTREAM_URL_LENGTH) {
    throw new AppError('url is too long', 400, 'INVALID_UPSTREAM_URL');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AppError('url must be a valid absolute URL', 400, 'INVALID_UPSTREAM_URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('url must use http or https', 400, 'INVALID_UPSTREAM_URL');
  }

  if (config.isProduction && parsed.protocol !== 'https:') {
    throw new AppError('url must use https in production', 400, 'INVALID_UPSTREAM_URL');
  }

  if (parsed.username || parsed.password) {
    throw new AppError('url must not include credentials', 400, 'INVALID_UPSTREAM_URL');
  }

  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();

  if (isBlockedIpLiteral(hostname) || isBlockedHostname(hostname)) {
    throw new AppError('url host is not allowed', 403, 'UPSTREAM_HOST_DENIED');
  }

  if (config.urlProxyMode === 'allowlist') {
    if (!config.allowedUpstreamHosts.includes(host)) {
      throw new AppError(
        'url host is not in ALLOWED_UPSTREAM_HOSTS',
        403,
        'UPSTREAM_HOST_DENIED'
      );
    }
  }

  return parsed;
}

/**
 * Resolve DNS and reject private / link-local answers (SSRF hardening).
 * @param {string} hostname
 */
async function assertHostnameResolvesPublic(hostname) {
  if (isBlockedIpLiteral(hostname) || isBlockedHostname(hostname)) {
    throw new AppError('url host is not allowed', 403, 'UPSTREAM_HOST_DENIED');
  }

  // Literal public IPs already passed isBlockedIpLiteral — nothing to resolve
  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
    return;
  }

  // Unit tests mock fetch against fake hosts; skip real DNS there.
  // SSRF IP/hostname blocks above still apply in tests.
  if (getConfig().isTest) {
    return;
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(
      'Unable to resolve upstream video host',
      502,
      'UPSTREAM_DNS_FAILED'
    );
  }

  if (!records || records.length === 0) {
    throw new AppError(
      'Unable to resolve upstream video host',
      502,
      'UPSTREAM_DNS_FAILED'
    );
  }

  for (const record of records) {
    if (isBlockedIpLiteral(record.address)) {
      throw new AppError(
        'url host resolves to a private or link-local address',
        403,
        'UPSTREAM_HOST_DENIED'
      );
    }
  }
}

/**
 * Resolve final upstream URL from either videoId or client URL mode.
 * @param {{ videoId?: string, upstreamUrl?: string }} params
 * @returns {{ url: string, label: string, attachProviderAuth: boolean }}
 */
function resolveUpstreamTarget({ videoId, upstreamUrl } = {}) {
  const config = getConfig();

  if (upstreamUrl) {
    const parsed = validateClientUpstreamUrl(upstreamUrl);

    // Never attach provider credentials to arbitrary third-party hosts.
    // Only when the URL host matches the configured BASE_URL host.
    let attachProviderAuth = false;
    if (config.videoProvider.baseUrl) {
      try {
        attachProviderAuth =
          parsed.host.toLowerCase() === new URL(config.videoProvider.baseUrl).host.toLowerCase();
      } catch {
        attachProviderAuth = false;
      }
    }

    if (
      attachProviderAuth &&
      config.videoProvider.authType === 'query' &&
      config.videoProvider.token &&
      !parsed.searchParams.has(config.videoProvider.authQueryParam)
    ) {
      parsed.searchParams.set(
        config.videoProvider.authQueryParam,
        config.videoProvider.token
      );
    }

    return {
      url: parsed.toString(),
      label: parsed.pathname.slice(0, 64) || parsed.host,
      attachProviderAuth,
    };
  }

  if (!videoId) {
    throw new AppError('Video ID or url is required', 400, 'INVALID_REQUEST');
  }

  return {
    url: buildUpstreamUrl(videoId),
    label: videoId,
    attachProviderAuth: true,
  };
}

/**
 * Build authentication and forwarding headers for the upstream request.
 * Provider credentials are injected only here (server-side).
 * @param {object} options
 * @param {string} [options.range]
 * @param {string} [options.method]
 * @param {boolean} [options.attachProviderAuth]
 * @returns {Record<string, string>}
 */
function buildUpstreamHeaders({
  range,
  method = 'GET',
  attachProviderAuth = true,
} = {}) {
  const config = getConfig();
  const { token, authType, authHeader, extraHeaders, referer } = config.videoProvider;

  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'video/*,application/vnd.apple.mpegurl,application/octet-stream,*/*',
  };

  // Provider-specific extra headers only when talking to the configured provider
  if (attachProviderAuth && extraHeaders) {
    Object.assign(headers, extraHeaders);
  }

  // Fixed upstream Referer from env (safe for multi-host; not client-controlled)
  if (referer) {
    headers.Referer = referer;
  }

  if (range) {
    headers.Range = range;
  }

  if (method === 'HEAD') {
    headers['Accept-Encoding'] = 'identity';
  }

  if (attachProviderAuth && token) {
    switch (authType) {
      case 'bearer':
        headers.Authorization = `Bearer ${token}`;
        break;
      case 'header':
        headers[authHeader] = token;
        break;
      case 'query':
        break;
      case 'signed-url':
        headers.Authorization = `Bearer ${token}`;
        break;
      default:
        break;
    }
  }

  return headers;
}

/**
 * Map upstream HTTP status codes to operational AppErrors.
 * @param {number} status
 * @returns {AppError}
 */
function mapUpstreamError(status) {
  switch (status) {
    case 401:
      return new AppError(
        'Upstream provider rejected authentication',
        502,
        'UPSTREAM_UNAUTHORIZED'
      );
    case 403:
      return new AppError(
        'Upstream provider denied access to this video',
        403,
        'UPSTREAM_FORBIDDEN'
      );
    case 404:
      return new AppError('Video not found', 404, 'VIDEO_NOT_FOUND');
    case 416:
      return new AppError('Requested range not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
    case 429:
      return new AppError('Upstream provider rate limited the request', 502, 'UPSTREAM_RATE_LIMITED');
    default:
      if (status >= 500) {
        return new AppError('Upstream provider error', 502, 'UPSTREAM_ERROR');
      }
      return new AppError('Failed to retrieve video from provider', 502, 'UPSTREAM_ERROR');
  }
}

/**
 * Resolve a playlist URI against the playlist URL and, when allowlisted,
 * rewrite it to /api/videos/stream?url=... so HLS.js keeps using the proxy.
 * Non-allowlisted URIs are absolutized against the playlist (never left relative
 * to the proxy path).
 *
 * @param {string} uri
 * @param {string} playlistUrl
 * @returns {string}
 */
function mapPlaylistUriToProxy(uri, playlistUrl) {
  if (typeof uri !== 'string' || !uri.trim()) {
    return uri;
  }

  let absolute;
  try {
    absolute = new URL(uri.trim(), playlistUrl).toString();
  } catch {
    return uri;
  }

  try {
    validateClientUpstreamUrl(absolute);
    return `/api/videos/stream?url=${encodeURIComponent(absolute)}`;
  } catch {
    return absolute;
  }
}

/**
 * Headers safe to forward from upstream to the client.
 * Authorization and set-cookie are intentionally excluded.
 */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
];

/**
 * @param {Headers} upstreamHeaders
 * @returns {Record<string, string>}
 */
function pickForwardHeaders(upstreamHeaders) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  if (!headers['accept-ranges']) {
    headers['accept-ranges'] = 'bytes';
  }
  return headers;
}

/**
 * Fetch a video (or metadata via HEAD) from the configured upstream provider.
 * Streams the body — does not buffer the full file into memory.
 *
 * @param {object} params
 * @param {string} [params.videoId]
 * @param {string} [params.upstreamUrl]
 * @param {'GET'|'HEAD'} [params.method]
 * @param {string} [params.range]
 * @param {AbortSignal} [params.signal]
 * @param {string} [params.requestId]
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: import('stream').Readable | null,
 *   upstreamUrlHost: string
 * }>}
 */
async function fetchVideoStream({
  videoId,
  upstreamUrl,
  method = 'GET',
  range,
  signal,
  requestId,
}) {
  const config = getConfig();
  const target = resolveUpstreamTarget({ videoId, upstreamUrl });
  const resolvedUrl = target.url;
  const resolvedParsed = new URL(resolvedUrl);
  const upstreamUrlHost = resolvedParsed.host;

  // DNS / SSRF check before connecting (especially important for URL_PROXY_MODE=any)
  await assertHostnameResolvesPublic(resolvedParsed.hostname);

  const headers = buildUpstreamHeaders({
    range,
    method,
    attachProviderAuth: target.attachProviderAuth,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('UPSTREAM_TIMEOUT'));
  }, config.videoProvider.timeoutMs);

  const onExternalAbort = () => {
    controller.abort(signal?.reason || new Error('CLIENT_ABORT'));
  };

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      throw new AppError('Request cancelled', 499, 'CLIENT_CANCELLED');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(resolvedUrl, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });

    const durationMs = Date.now() - startedAt;

    logger.info('Upstream video response', {
      requestId,
      videoId: videoId || target.label,
      method,
      upstreamStatus: response.status,
      durationMs,
      upstreamHost: upstreamUrlHost,
      hasRange: Boolean(range),
      mode: upstreamUrl ? 'url' : 'id',
    });

    if ([301, 302, 307, 308].includes(response.status)) {
      throw new AppError(
        'Upstream redirected; use the final video URL or update PATH_TEMPLATE',
        502,
        'UPSTREAM_REDIRECT'
      );
    }

    if (response.status === 416) {
      throw mapUpstreamError(416);
    }

    if (!(response.status === 200 || response.status === 206)) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // ignore
        }
      }
      throw mapUpstreamError(response.status);
    }

    const responseHeaders = pickForwardHeaders(response.headers);
    const contentType = response.headers.get('content-type') || responseHeaders['content-type'];
    const shouldRewritePlaylist =
      method !== 'HEAD' &&
      response.status === 200 &&
      !range &&
      isHlsPlaylist({ contentType, url: resolvedUrl });

    let body = null;
    if (method !== 'HEAD' && response.body) {
      body = Readable.fromWeb(response.body);
      body.on('error', (err) => {
        logger.warn('Upstream stream error', {
          requestId,
          videoId: videoId || target.label,
          error: err.message,
        });
      });
    }

    if (shouldRewritePlaylist && body) {
      try {
        const playlistText = await readPlaylistText(body);
        const rewritten = rewriteHlsPlaylist(playlistText, (uri) =>
          mapPlaylistUriToProxy(uri, resolvedUrl)
        );
        const rewrittenBuffer = Buffer.from(rewritten, 'utf8');

        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'application/vnd.apple.mpegurl';
        }
        responseHeaders['content-length'] = String(rewrittenBuffer.length);
        delete responseHeaders['content-range'];

        body = Readable.from(rewrittenBuffer);

        logger.info('Rewrote HLS playlist URIs through proxy', {
          requestId,
          videoId: videoId || target.label,
          upstreamHost: upstreamUrlHost,
          bytes: rewrittenBuffer.length,
        });
      } catch (err) {
        if (err && err.code === 'PLAYLIST_TOO_LARGE') {
          throw new AppError('Upstream HLS playlist is too large', 502, 'PLAYLIST_TOO_LARGE');
        }
        throw err;
      }
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body,
      upstreamUrlHost,
    };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }

    const reason = controller.signal.reason;
    const reasonMessage =
      reason instanceof Error ? reason.message : reason ? String(reason) : '';
    const message = err?.message || String(err);
    const name = err?.name || '';

    if (reasonMessage === 'UPSTREAM_TIMEOUT' || message === 'UPSTREAM_TIMEOUT') {
      throw new AppError('Upstream provider timed out', 504, 'UPSTREAM_TIMEOUT');
    }

    if (
      reasonMessage === 'CLIENT_ABORT' ||
      message === 'CLIENT_ABORT' ||
      (signal && signal.aborted)
    ) {
      throw new AppError('Request cancelled', 499, 'CLIENT_CANCELLED');
    }

    if (name === 'AbortError' || /aborted/i.test(message)) {
      throw new AppError('Request cancelled', 499, 'CLIENT_CANCELLED');
    }

    logger.error('Upstream connection failure', {
      requestId,
      videoId: videoId || target.label,
      upstreamHost: upstreamUrlHost,
      error: message,
    });

    throw new AppError(
      'Unable to connect to upstream video provider',
      502,
      'UPSTREAM_CONNECTION_FAILED'
    );
  } finally {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

module.exports = {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  fetchVideoStream,
  pickForwardHeaders,
  mapUpstreamError,
  validateClientUpstreamUrl,
  resolveUpstreamTarget,
  mapPlaylistUriToProxy,
  assertHostnameResolvesPublic,
  isBlockedIpLiteral,
  isBlockedHostname,
  FORWARDED_RESPONSE_HEADERS,
  MAX_UPSTREAM_URL_LENGTH,
};
