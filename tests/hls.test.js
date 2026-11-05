'use strict';

require('./setupEnv');

const {
  isHlsPlaylist,
  rewriteHlsPlaylist,
} = require('../src/services/hls.service');
const { mapPlaylistUriToProxy, validateClientUpstreamUrl } = require('../src/services/video.service');
const { resetConfig } = require('../src/config/env');

describe('HLS playlist rewriting', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('detects m3u8 by content-type and URL', () => {
    expect(
      isHlsPlaylist({
        contentType: 'application/vnd.apple.mpegurl',
        url: 'https://cdn.allowed.test/a',
      })
    ).toBe(true);
    expect(
      isHlsPlaylist({
        contentType: 'video/mp4',
        url: 'https://cdn.allowed.test/master.m3u8',
      })
    ).toBe(true);
    expect(
      isHlsPlaylist({
        contentType: 'video/mp4',
        url: 'https://cdn.allowed.test/clip.mp4',
      })
    ).toBe(false);
  });

  it('rewrites relative and absolute allowlisted URIs through the proxy', () => {
    const playlistUrl = 'https://cdn.allowed.test/p/scxqicy/master.m3u8';
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
      '1080/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'https://cdn.allowed.test/p/scxqicy/360/index.m3u8',
      '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.key"',
      '',
    ].join('\n');

    const output = rewriteHlsPlaylist(input, (uri) => mapPlaylistUriToProxy(uri, playlistUrl));

    expect(output).toContain(
      `/api/videos/stream?url=${encodeURIComponent('https://cdn.allowed.test/p/scxqicy/1080/index.m3u8')}`
    );
    expect(output).toContain(
      `/api/videos/stream?url=${encodeURIComponent('https://cdn.allowed.test/p/scxqicy/360/index.m3u8')}`
    );
    expect(output).toContain(
      `URI="${`/api/videos/stream?url=${encodeURIComponent('https://cdn.allowed.test/p/scxqicy/keys/key.key')}`}"`
    );
    expect(output).not.toContain('\n1080/index.m3u8\n');
  });

  it('absolutizes non-allowlisted URIs instead of leaving them relative', () => {
    const playlistUrl = 'https://cdn.allowed.test/master.m3u8';
    const input = '#EXTM3U\nhttps://evil.example.com/seg.ts\n';
    const output = rewriteHlsPlaylist(input, (uri) => mapPlaylistUriToProxy(uri, playlistUrl));

    expect(output).toContain('https://evil.example.com/seg.ts');
    expect(output).not.toContain('/api/videos/stream?url=');
    expect(() => validateClientUpstreamUrl('https://evil.example.com/seg.ts')).toThrow();
  });
});
