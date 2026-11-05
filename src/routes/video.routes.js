'use strict';

const express = require('express');
const {
  getVideo,
  headVideo,
  getVideoByUrl,
  headVideoByUrl,
} = require('../controllers/video.controller');
const {
  requireProxyAuth,
  validateVideoId,
  validateUpstreamUrlQuery,
} = require('../middleware/auth.middleware');

const router = express.Router();

router.use(requireProxyAuth);

// Full-URL streaming (allowlisted hosts only) — register before /:videoId
router.head('/stream', validateUpstreamUrlQuery, headVideoByUrl);
router.get('/stream', validateUpstreamUrlQuery, getVideoByUrl);

// ID-based streaming
router.head('/:videoId', validateVideoId, headVideo);
router.get('/:videoId', validateVideoId, getVideo);

module.exports = router;
