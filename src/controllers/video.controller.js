'use strict';

const { fetchVideoStream } = require('../services/video.service');
const { AppError } = require('../middleware/error.middleware');
const { logger } = require('../utils/logger');

/**
 * Pipe an upstream video stream to the Express response.
 * Handles Range / 206, client abort, and cleanup.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {'GET'|'HEAD'} method
 * @param {{ videoId?: string, upstreamUrl?: string }} target
 */
async function proxyVideo(req, res, next, method, target) {
  const videoId = target.videoId;
  const upstreamUrl = target.upstreamUrl;
  const logLabel = videoId || 'url-stream';
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const requestId = req.requestId;
  const startedAt = req.startedAt || Date.now();

  const abortController = new AbortController();

  const onClientClose = () => {
    if (!res.writableEnded) {
      abortController.abort(new Error('CLIENT_ABORT'));
    }
  };

  req.on('close', onClientClose);
  res.on('close', onClientClose);

  try {
    const upstream = await fetchVideoStream({
      videoId,
      upstreamUrl,
      method,
      range,
      signal: abortController.signal,
      requestId,
    });

    res.status(upstream.status);
    for (const [name, value] of Object.entries(upstream.headers)) {
      res.setHeader(name, value);
    }

    res.setHeader('X-Proxy-Cache', 'MISS');

    if (method === 'HEAD' || !upstream.body) {
      logger.info('Video HEAD completed', {
        requestId,
        videoId: logLabel,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      });
      res.end();
      return;
    }

    upstream.body.on('error', (err) => {
      logger.warn('Stream pipe error', {
        requestId,
        videoId: logLabel,
        error: err.message,
      });
      if (!res.headersSent) {
        next(new AppError('Stream interrupted', 502, 'STREAM_ERROR'));
      } else if (!res.destroyed) {
        res.destroy(err);
      }
    });

    res.on('finish', () => {
      logger.info('Video stream completed', {
        requestId,
        videoId: logLabel,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        hasRange: Boolean(range),
      });
    });

    upstream.body.pipe(res);
  } catch (err) {
    if (
      err instanceof AppError &&
      err.code === 'CLIENT_CANCELLED' &&
      (res.writableEnded || req.aborted || req.destroyed)
    ) {
      logger.info('Client disconnected during video proxy', {
        requestId,
        videoId: logLabel,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (err instanceof AppError && err.statusCode === 499) {
      err.statusCode = 400;
    }

    next(err);
  } finally {
    req.off('close', onClientClose);
    res.off('close', onClientClose);
  }
}

/**
 * GET /api/videos/:videoId — stream video with Range support.
 */
async function getVideo(req, res, next) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  return proxyVideo(req, res, next, method, { videoId: req.params.videoId });
}

/**
 * HEAD /api/videos/:videoId — metadata only when upstream supports HEAD.
 */
async function headVideo(req, res, next) {
  return proxyVideo(req, res, next, 'HEAD', { videoId: req.params.videoId });
}

/**
 * GET /api/videos/stream?url= — stream from an allowlisted full URL.
 */
async function getVideoByUrl(req, res, next) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  return proxyVideo(req, res, next, method, { upstreamUrl: req.validatedUpstreamUrl });
}

/**
 * HEAD /api/videos/stream?url=
 */
async function headVideoByUrl(req, res, next) {
  return proxyVideo(req, res, next, 'HEAD', { upstreamUrl: req.validatedUpstreamUrl });
}

module.exports = {
  getVideo,
  headVideo,
  getVideoByUrl,
  headVideoByUrl,
  proxyVideo,
};
