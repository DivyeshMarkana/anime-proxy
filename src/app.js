'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getConfig } = require('./config/env');
const videoRoutes = require('./routes/video.routes');
const {
  requestContextMiddleware,
  errorHandler,
  notFoundHandler,
  AppError,
} = require('./middleware/error.middleware');
const { logger } = require('./utils/logger');

/**
 * Build the Express application (no listen — used by server and tests).
 * @returns {import('express').Express}
 */
function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestContextMiddleware);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    })
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Allow non-browser clients (no Origin) such as server health checks
        if (!origin) {
          return callback(null, true);
        }
        if (config.allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        logger.warn('CORS blocked origin', { origin });
        return callback(new AppError('Origin not allowed', 403, 'CORS_DENIED'));
      },
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'X-API-Key', 'Range', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: [
        'Accept-Ranges',
        'Content-Range',
        'Content-Length',
        'Content-Type',
        'ETag',
        'X-Request-Id',
      ],
      maxAge: 600,
    })
  );

  // JSON only for non-streaming utility routes; video routes never parse a body
  app.use(express.json({ limit: '16kb' }));

  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
      },
    },
  });

  app.use('/api/', limiter);

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'video-proxy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      environment: config.nodeEnv,
      // Intentionally omit tokens, keys, and upstream credentials
    });
  });

  app.use('/api/videos', videoRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
};
