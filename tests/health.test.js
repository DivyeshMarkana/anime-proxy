'use strict';

require('./setupEnv');

const request = require('supertest');
const { resetConfig } = require('../src/config/env');
const { createApp } = require('../src/app');

describe('GET /health', () => {
  let app;

  beforeEach(() => {
    resetConfig();
    app = createApp();
  });

  it('returns server status without secrets', async () => {
    const res = await request(app).get('/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('video-proxy');
    expect(res.body.environment).toBe('test');
    expect(res.body).toHaveProperty('uptimeSeconds');
    expect(res.body).toHaveProperty('timestamp');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/test-provider-token|test-proxy-api-key|VIDEO_PROVIDER/i);
  });
});
