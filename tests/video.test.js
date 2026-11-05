'use strict';

require('./setupEnv');

const http = require('http');
const request = require('supertest');
const { resetConfig } = require('../src/config/env');
const { createApp } = require('../src/app');
const { mockFetchResponse, delay } = require('./helpers');

const API_KEY = 'test-proxy-api-key-16chars';
const VIDEO_BYTES = Buffer.from('FAKE_MP4_CONTENT_FOR_STREAMING_TESTS_0123456789');

describe('Video proxy endpoints', () => {
  let app;
  let fetchMock;

  beforeEach(() => {
    resetConfig();
    app = createApp();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.UPSTREAM_TIMEOUT = '2000';
    process.env.URL_PROXY_MODE = 'allowlist';
    resetConfig();
  });

  function authGet(path) {
    return request(app).get(path).set('X-API-Key', API_KEY);
  }

  it('streams a valid video request (200)', async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
          'accept-ranges': 'bytes',
        },
        body: VIDEO_BYTES,
      })
    );

    const res = await authGet('/api/videos/abc-123').expect(200);

    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(VIDEO_BYTES.length));
    expect(Buffer.from(res.body).equals(VIDEO_BYTES)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://video-provider.test/videos/abc-123');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer test-provider-token');
    expect(options.headers.Referer).toBe('https://mac.video.com/');
  });

  it('rejects invalid video IDs', async () => {
    const res = await authGet('/api/videos/invalid!!id').expect(400);
    expect(res.body.error.code).toBe('INVALID_VIDEO_ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unauthorized requests', async () => {
    const res = await request(app).get('/api/videos/abc-123').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps upstream 403 to client 403', async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'forbidden' }),
      })
    );

    const res = await authGet('/api/videos/secret-video').expect(403);
    expect(res.body.error.code).toBe('UPSTREAM_FORBIDDEN');
  });

  it('maps upstream 404 to client 404', async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'missing' }),
      })
    );

    const res = await authGet('/api/videos/missing-id').expect(404);
    expect(res.body.error.code).toBe('VIDEO_NOT_FOUND');
  });

  it('forwards Range and returns 206 Partial Content', async () => {
    const slice = VIDEO_BYTES.subarray(0, 10);

    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(slice.length),
          'content-range': `bytes 0-9/${VIDEO_BYTES.length}`,
          'accept-ranges': 'bytes',
        },
        body: slice,
      })
    );

    const res = await authGet('/api/videos/abc-123')
      .set('Range', 'bytes=0-9')
      .expect(206);

    expect(res.headers['content-range']).toBe(`bytes 0-9/${VIDEO_BYTES.length}`);
    expect(res.headers['content-length']).toBe('10');
    expect(Buffer.from(res.body).equals(slice)).toBe(true);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Range).toBe('bytes=0-9');
  });

  it('maps upstream 416 Range Not Satisfiable', async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 416,
        headers: {
          'content-range': 'bytes */40',
        },
        body: null,
      })
    );

    const res = await authGet('/api/videos/abc-123')
      .set('Range', 'bytes=9999-10000')
      .expect(416);

    expect(res.body.error.code).toBe('RANGE_NOT_SATISFIABLE');
  });

  it('supports HEAD requests', async () => {
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
          'accept-ranges': 'bytes',
        },
        body: null,
      })
    );

    const res = await request(app)
      .head('/api/videos/abc-123')
      .set('X-API-Key', API_KEY)
      .expect(200);

    expect(res.headers['content-type']).toMatch(/video\/mp4/);
    expect(res.headers['content-length']).toBe(String(VIDEO_BYTES.length));
    expect(res.text === undefined || res.text === '').toBe(true);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('HEAD');
  });

  it('returns 504 on upstream timeout', async () => {
    fetchMock.mockImplementation((_url, options) => {
      return delay(5000, options.signal).then(() =>
        mockFetchResponse({ status: 200, body: VIDEO_BYTES })
      );
    });

    // Temporarily use a short timeout via env + reset
    process.env.UPSTREAM_TIMEOUT = '100';
    resetConfig();
    app = createApp();

    const res = await request(app)
      .get('/api/videos/slow-video')
      .set('X-API-Key', API_KEY)
      .expect(504);

    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');

    process.env.UPSTREAM_TIMEOUT = '2000';
    resetConfig();
  });

  it('streams from an allowlisted full URL', async () => {
    const fullUrl = 'https://cdn.allowed.test/path/to/movie.mp4';

    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
          'accept-ranges': 'bytes',
        },
        body: VIDEO_BYTES,
      })
    );

    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent(fullUrl)}`
    ).expect(200);

    expect(Buffer.from(res.body).equals(VIDEO_BYTES)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(fullUrl);
    // Other allowlisted hosts do not receive provider bearer token
    expect(options.headers.Authorization).toBeUndefined();
    // Fixed env Referer is still sent on every upstream fetch
    expect(options.headers.Referer).toBe('https://mac.video.com/');
  });

  it('rewrites relative HLS playlist URIs through /api/videos/stream', async () => {
    const masterUrl = 'https://cdn.allowed.test/p/scxqicy/master.m3u8';
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
      '1080/index.m3u8',
      '',
    ].join('\n');

    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(Buffer.byteLength(playlist)),
        },
        body: playlist,
      })
    );

    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent(masterUrl)}`
    ).expect(200);

    const body = res.text || Buffer.from(res.body).toString('utf8');
    const expectedChild = 'https://cdn.allowed.test/p/scxqicy/1080/index.m3u8';
    expect(body).toContain(
      `/api/videos/stream?url=${encodeURIComponent(expectedChild)}`
    );
    expect(body).not.toMatch(/(^|\n)1080\/index\.m3u8(\n|$)/);
    expect(fetchMock.mock.calls[0][0]).toBe(masterUrl);
  });

  it('attaches provider auth when full URL host matches BASE_URL host', async () => {
    const fullUrl = 'https://video-provider.test/custom/path/file.mp4';

    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
        },
        body: VIDEO_BYTES,
      })
    );

    await authGet(`/api/videos/stream?url=${encodeURIComponent(fullUrl)}`).expect(200);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-provider-token');
  });

  it('rejects full URLs for hosts not in the allowlist', async () => {
    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent('https://evil.example.com/a.mp4')}`
    ).expect(403);

    expect(res.body.error.code).toBe('UPSTREAM_HOST_DENIED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects private / localhost upstream URLs', async () => {
    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent('http://127.0.0.1/secret.mp4')}`
    ).expect(403);
    expect(res.body.error.code).toBe('UPSTREAM_HOST_DENIED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL_PROXY_MODE=any allows arbitrary public hosts with proxy auth', async () => {
    process.env.URL_PROXY_MODE = 'any';
    resetConfig();
    app = createApp();

    const fullUrl = 'https://random-cdn.example.org/show/ep1.mp4';
    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(VIDEO_BYTES.length),
        },
        body: VIDEO_BYTES,
      })
    );

    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent(fullUrl)}`
    ).expect(200);

    expect(Buffer.from(res.body).equals(VIDEO_BYTES)).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(fullUrl);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers.Referer).toBe('https://mac.video.com/');

    process.env.URL_PROXY_MODE = 'allowlist';
    resetConfig();
  });

  it('URL_PROXY_MODE=any still blocks SSRF targets', async () => {
    process.env.URL_PROXY_MODE = 'any';
    resetConfig();
    app = createApp();

    const res = await authGet(
      `/api/videos/stream?url=${encodeURIComponent('https://169.254.169.254/latest/meta-data/')}`
    ).expect(403);

    expect(res.body.error.code).toBe('UPSTREAM_HOST_DENIED');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.URL_PROXY_MODE = 'allowlist';
    resetConfig();
  });

  it('rejects missing url query on /stream', async () => {
    const res = await authGet('/api/videos/stream').expect(400);
    expect(res.body.error.code).toBe('INVALID_UPSTREAM_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports Range on full-URL streaming', async () => {
    const slice = VIDEO_BYTES.subarray(0, 10);
    const fullUrl = 'https://cdn.allowed.test/clip.mp4';

    fetchMock.mockResolvedValue(
      mockFetchResponse({
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(slice.length),
          'content-range': `bytes 0-9/${VIDEO_BYTES.length}`,
          'accept-ranges': 'bytes',
        },
        body: slice,
      })
    );

    const res = await authGet(`/api/videos/stream?url=${encodeURIComponent(fullUrl)}`)
      .set('Range', 'bytes=0-9')
      .expect(206);

    expect(res.headers['content-range']).toBe(`bytes 0-9/${VIDEO_BYTES.length}`);
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Range).toBe('bytes=0-9');
  });

  it('cancels upstream fetch when the client disconnects', async () => {
    let abortSeen = false;

    fetchMock.mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => {
          abortSeen = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    await new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address();
        const clientReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/videos/disconnect-me',
            method: 'GET',
            headers: { 'X-API-Key': API_KEY },
          },
          () => {}
        );

        clientReq.on('error', () => {
          // Expected when the client socket is destroyed
        });

        clientReq.flushHeaders();

        setTimeout(() => {
          clientReq.destroy();
        }, 50);

        setTimeout(() => {
          server.close(() => {
            try {
              expect(abortSeen).toBe(true);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        }, 400);
      });
    });
  });
});

