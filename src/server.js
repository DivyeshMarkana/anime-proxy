'use strict';

const { getConfig } = require('./config/env');
const { createApp } = require('./app');
const { logger } = require('./utils/logger');

function start() {
  try {
    const config = getConfig();
    const app = createApp();

    const server = app.listen(config.port, () => {
      logger.info('Video proxy server started', {
        port: config.port,
        environment: config.nodeEnv,
        allowedOrigins: config.allowedOrigins,
        urlProxyMode: config.urlProxyMode,
        upstreamHost: config.videoProvider.baseUrl
          ? new URL(config.videoProvider.baseUrl).host
          : null,
        authType: config.videoProvider.authType,
      });
    });

    const shutdown = (signal) => {
      logger.info('Shutting down', { signal });
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', {
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });

    return server;
  } catch (err) {
    logger.error('Failed to start server', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { start };
