'use strict';

const { logger } = require('../utils/logger');

class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} [code]
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

/**
 * Attach a request ID and start timer for duration logging.
 */
function requestContextMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  req.requestId =
    typeof incomingId === 'string' && incomingId.trim()
      ? incomingId.trim().slice(0, 64)
      : `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/**
 * Centralized Express error handler.
 * Never leaks upstream credentials or stack traces to clients in production.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const isOperational = Boolean(err.isOperational);
  const durationMs = req.startedAt ? Date.now() - req.startedAt : undefined;

  logger.error('Request failed', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    videoId: req.params?.videoId,
    statusCode,
    code,
    durationMs,
    error: isOperational ? err.message : 'Internal server error',
  });

  const clientMessage =
    statusCode >= 500 && !isOperational
      ? 'An unexpected error occurred'
      : err.message || 'Request failed';

  res.status(statusCode).json({
    error: {
      code,
      message: clientMessage,
      requestId: req.requestId,
    },
  });
}

/**
 * 404 handler for unknown routes.
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
      requestId: req.requestId,
    },
  });
}

module.exports = {
  AppError,
  requestContextMiddleware,
  errorHandler,
  notFoundHandler,
};
