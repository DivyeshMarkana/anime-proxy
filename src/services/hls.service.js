'use strict';

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
];

/**
 * @param {string|null|undefined} contentType
 * @returns {boolean}
 */
function isHlsPlaylistContentType(contentType) {
  if (!contentType || typeof contentType !== 'string') {
    return false;
  }
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  return HLS_CONTENT_TYPES.some((type) => normalized === type || normalized.includes('mpegurl'));
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isHlsPlaylistUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

/**
 * True when the upstream response should be treated as an HLS playlist.
 * @param {{ contentType?: string, url: string }} params
 * @returns {boolean}
 */
function isHlsPlaylist({ contentType, url }) {
  return isHlsPlaylistContentType(contentType) || isHlsPlaylistUrl(url);
}

/**
 * Read a stream into a UTF-8 string with a hard size cap.
 * @param {import('stream').Readable} stream
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
async function readPlaylistText(stream, maxBytes = MAX_PLAYLIST_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      const err = new Error('PLAYLIST_TOO_LARGE');
      err.code = 'PLAYLIST_TOO_LARGE';
      throw err;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Map a playlist URI through the provided mapper (usually to /api/videos/stream?url=...).
 * @param {string} playlistText
 * @param {(uri: string) => string} mapUri
 * @returns {string}
 */
function rewriteHlsPlaylist(playlistText, mapUri) {
  if (typeof playlistText !== 'string' || typeof mapUri !== 'function') {
    return playlistText;
  }

  const normalized = playlistText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized
    .split('\n')
    .map((line) => rewritePlaylistLine(line, mapUri))
    .join('\n');
}

/**
 * @param {string} line
 * @param {(uri: string) => string} mapUri
 * @returns {string}
 */
function rewritePlaylistLine(line, mapUri) {
  const trimmed = line.trim();
  if (!trimmed) {
    return line;
  }

  if (trimmed.startsWith('#')) {
    if (!/URI=/i.test(trimmed)) {
      return line;
    }
    return line.replace(/URI=(?:"([^"]*)"|([^,\s]+))/gi, (_match, quoted, unquoted) => {
      const uri = quoted !== undefined ? quoted : unquoted;
      const mapped = mapUri(uri);
      return `URI="${mapped}"`;
    });
  }

  return mapUri(trimmed);
}

module.exports = {
  MAX_PLAYLIST_BYTES,
  isHlsPlaylistContentType,
  isHlsPlaylistUrl,
  isHlsPlaylist,
  readPlaylistText,
  rewriteHlsPlaylist,
  rewritePlaylistLine,
};
