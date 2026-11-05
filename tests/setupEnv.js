'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.ALLOWED_ORIGINS = 'https://mac.video.com,http://localhost:4200';
process.env.URL_PROXY_MODE = 'allowlist';
process.env.VIDEO_PROVIDER_BASE_URL = 'https://video-provider.test';
process.env.VIDEO_PROVIDER_TOKEN = 'test-provider-token';
process.env.VIDEO_PROVIDER_AUTH_TYPE = 'bearer';
process.env.VIDEO_PROVIDER_PATH_TEMPLATE = '/videos/{videoId}';
process.env.VIDEO_PROVIDER_REFERER = 'https://mac.video.com/';
process.env.ALLOWED_UPSTREAM_HOSTS = 'video-provider.test,cdn.allowed.test';
process.env.UPSTREAM_TIMEOUT = '2000';
process.env.PROXY_API_KEY = 'test-proxy-api-key-16chars';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX = '1000';
process.env.LOG_LEVEL = 'error';
