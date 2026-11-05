'use strict';

const { getConfig } = require('../config/env');
const { AppError } = require('./error.middleware');

/**
 * Extract API key from Authorization Bearer or X-API-Key header.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractApiKey(req) {
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Constant-time string comparison to reduce timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still compare equal-length buffers to keep timing closer
    const dummy = Buffer.alloc(bufA.length);
    require('crypto').timingSafeEqual(bufA, dummy);
    return false;
  }
  return require('crypto').timingSafeEqual(bufA, bufB);
}

/**
 * Require a valid proxy API key for video endpoints.
 * Provider credentials are never accepted from the client.
 */
function requireProxyAuth(req, _res, next) {
  const config = getConfig();

  if (!config.proxyApiKey) {
    if (config.isProduction) {
      return next(
        new AppError('Proxy authentication is not configured', 500, 'AUTH_MISCONFIGURED')
      );
    }
    // Development convenience when PROXY_API_KEY is empty
    return next();
  }

  const provided = extractApiKey(req);
  if (!provided || !timingSafeEqual(provided, config.proxyApiKey)) {
    return next(new AppError('Unauthorized', 401, 'UNAUTHORIZED'));
  }

  return next();
}

/**
 * Validate videoId path parameter.
 * Only allows safe identifiers — never arbitrary URLs or path traversal.
 */
function validateVideoId(req, _res, next) {
  const videoId = req.params.videoId;

  if (typeof videoId !== 'string' || !videoId.trim()) {
    return next(new AppError('Video ID is required', 400, 'INVALID_VIDEO_ID'));
  }

  // Alphanumeric, hyphen, underscore, period — max 128 chars. No slashes or URLs.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(videoId)) {
    return next(
      new AppError(
        'Invalid video ID format. Use 1–128 characters: letters, numbers, ., _, -',
        400,
        'INVALID_VIDEO_ID'
      )
    );
  }

  // Reject values that look like URL schemes or encoded path segments
  if (videoId.includes('..') || /^(https?|ftp)$/i.test(videoId)) {
    return next(new AppError('Invalid video ID', 400, 'INVALID_VIDEO_ID'));
  }

  req.params.videoId = videoId;
  return next();
}

/**
 * Validate ?url= for allowlisted full-URL streaming.
 * Stores the raw validated string on req.validatedUpstreamUrl.
 */
function validateUpstreamUrlQuery(req, _res, next) {
  const { validateClientUpstreamUrl } = require('../services/video.service');

  try {
    const raw =
      typeof req.query.url === 'string'
        ? req.query.url
        : Array.isArray(req.query.url)
          ? req.query.url[0]
          : '';

    const parsed = validateClientUpstreamUrl(raw);
    req.validatedUpstreamUrl = parsed.toString();
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  requireProxyAuth,
  validateVideoId,
  validateUpstreamUrlQuery,
  extractApiKey,
  timingSafeEqual,
};
