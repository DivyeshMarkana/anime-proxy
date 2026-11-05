'use strict';

const { Readable } = require('stream');

/**
 * Build a mock Fetch Response with an optional streaming body.
 * @param {object} options
 * @param {number} [options.status]
 * @param {Record<string, string>} [options.headers]
 * @param {Buffer|string|null} [options.body]
 * @returns {Response}
 */
function mockFetchResponse({ status = 200, headers = {}, body = null } = {}) {
  const initHeaders = new Headers(headers);
  let responseBody = null;

  if (body !== null && body !== undefined) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    responseBody = Readable.toWeb(Readable.from(buffer));
  }

  return new Response(responseBody, {
    status,
    headers: initHeaders,
  });
}

/**
 * Create a delayed promise that rejects/resolves for timeout tests.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true }
      );
    }
  });
}

module.exports = {
  mockFetchResponse,
  delay,
};
