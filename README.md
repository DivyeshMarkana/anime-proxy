# Video Proxy Server

Production-oriented Node.js Express application that streams video from an authorized upstream provider to your Angular frontend (`https://mac.video.com`).

```
Angular (mac.video.com) → Node.js Video Proxy → Video Provider
```

The proxy authenticates **server-to-server** with the video provider using credentials from environment variables. It does **not** spoof `Referer` headers or bypass provider access controls. Provider tokens never reach the browser.

## Features

- Progressive MP4 streaming with native Node.js streams (no full-file buffering)
- HTTP Range / `206 Partial Content` for seeking, fast-forward, and rewind
- `HEAD` support for metadata probes
- CORS restricted to configured origins
- Helmet security headers
- Rate limiting
- Proxy API key authentication
- Strict video ID validation for ID-based routes
- Full-URL streaming via `GET /api/videos/stream?url=` (`URL_PROXY_MODE=any` or allowlist)
- SSRF protections (private IPs, localhost, metadata hosts, DNS checks)
- HLS `.m3u8` playlist URI rewriting through the proxy
- Centralized error handling and structured logging (credentials redacted)

> **HLS:** Master/media playlists fetched through `/stream?url=` are rewritten so child playlists and segments also go through the proxy. DASH is not implemented yet.

## Prerequisites

- Node.js **18+** (LTS recommended; uses the native Fetch API and `Readable.fromWeb`)
- npm 9+
- Network access from the proxy host to your video provider
- Valid provider credentials (token / API key / signed-URL secret)

## Project structure

```
video-proxy/
├── src/
│   ├── config/env.js
│   ├── controllers/video.controller.js
│   ├── services/video.service.js
│   ├── middleware/auth.middleware.js
│   ├── middleware/error.middleware.js
│   ├── routes/video.routes.js
│   ├── utils/logger.js
│   ├── app.js
│   └── server.js
├── tests/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Installation

```bash
cd video-proxy
npm install
cp .env.example .env
# Edit .env with your real values
```

## Environment configuration

| Variable | Required | Description |
|---|---|---|
| `PORT` | No (default `3000`) | HTTP listen port |
| `NODE_ENV` | No | `development`, `test`, or `production` |
| `ALLOWED_ORIGINS` | Yes in production | Comma-separated browser origins, e.g. `https://mac.video.com` |
| `URL_PROXY_MODE` | No (`allowlist`) | `allowlist` or `any` (multi-host; requires `PROXY_API_KEY`) |
| `VIDEO_PROVIDER_BASE_URL` | Optional | Needed only for ID mode `/api/videos/:videoId` |
| `VIDEO_PROVIDER_TOKEN` | Yes in production when using BASE_URL | Server-side provider credential (only sent to BASE_URL host) |
| `VIDEO_PROVIDER_AUTH_TYPE` | No (`bearer`) | `bearer`, `header`, `query`, or `signed-url` |
| `VIDEO_PROVIDER_AUTH_HEADER` | If `header` | Header name for the token (default `X-Api-Key`) |
| `VIDEO_PROVIDER_AUTH_QUERY_PARAM` | If `query` | Query param name (default `token`) |
| `VIDEO_PROVIDER_PATH_TEMPLATE` | For ID mode | Path with `{videoId}`, e.g. `/videos/{videoId}` |
| `VIDEO_PROVIDER_REFERER` | No | Fixed `Referer` sent on every upstream fetch (e.g. `https://zokoanime.video/`) |
| `ALLOWED_UPSTREAM_HOSTS` | If `allowlist` | Hosts allowed in `?url=` (ignored for host checks when `URL_PROXY_MODE=any`) |
| `VIDEO_PROVIDER_EXTRA_HEADERS` | No | JSON object of extra upstream headers |
| `UPSTREAM_TIMEOUT` | No (`30000`) | Upstream timeout in ms |
| `PROXY_API_KEY` | Yes in production | Key Angular must send to the proxy |
| `RATE_LIMIT_WINDOW_MS` | No | Rate-limit window |
| `RATE_LIMIT_MAX` | No | Max requests per window per IP |
| `LOG_LEVEL` | No (`info`) | `error`, `warn`, `info`, `debug` |

### Configuring the upstream provider

Because provider APIs differ, this proxy uses a **configurable path template** and **auth type** instead of inventing a proprietary upstream API.

1. Set `VIDEO_PROVIDER_BASE_URL` to the provider origin.
2. Set `VIDEO_PROVIDER_PATH_TEMPLATE` so `{videoId}` expands to the provider’s stream path.  
   Examples:
   - `/api/v1/videos/{videoId}/stream`
   - `/content/{videoId}.mp4`
3. Choose authentication:
   - **`bearer`** — `Authorization: Bearer <VIDEO_PROVIDER_TOKEN>`
   - **`header`** — `<VIDEO_PROVIDER_AUTH_HEADER>: <TOKEN>`
   - **`query`** — `?token=<TOKEN>` (or custom param name)
   - **`signed-url`** — use when the provider issues pre-signed URLs. Point `PATH_TEMPLATE` at the signed resource pattern your backend resolves, or keep a bearer fallback. **Provider-specific signing (HMAC, expiry, canonical strings) must be implemented against that provider’s docs** — do not invent signatures here.
4. Optionally set `VIDEO_PROVIDER_REFERER` if the provider expects a fixed site Referer (server-side only; not taken from the browser).
5. Confirm the provider supports `Range` / `206` for browser seeking.
6. Never put provider tokens in Angular or public env files.

If your provider requires a custom signing algorithm, extend `src/services/video.service.js` (`buildUpstreamUrl` / `buildUpstreamHeaders`) with a dedicated signer module and keep secrets in `.env`.

## Run locally

```bash
npm run dev    # restart on file changes (Node --watch)
# or
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Stream a video by ID (with proxy API key):

```bash
curl -H "X-API-Key: $PROXY_API_KEY" \
  -H "Range: bytes=0-1023" \
  -o chunk.mp4 \
  http://localhost:3000/api/videos/123
```

Stream by full upstream URL (host must be allowlisted):

```bash
curl -H "X-API-Key: $PROXY_API_KEY" \
  -o chunk.mp4 \
  "http://localhost:3000/api/videos/stream?url=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("https://hls.dramahot.top/path/file.mp4", safe=""))')"
```

## API endpoints

### `GET /health`

Returns process status. Does **not** expose secrets.

```json
{
  "status": "ok",
  "service": "video-proxy",
  "timestamp": "2026-11-03T12:00:00.000Z",
  "uptimeSeconds": 12,
  "environment": "development"
}
```

### `GET /api/videos/:videoId`

Proxies and streams the video. Supports `Range`.

**Headers**

| Header | Required | Description |
|---|---|---|
| `Authorization: Bearer <PROXY_API_KEY>` or `X-API-Key` | Yes (when key configured) | Proxy auth — **not** the provider token |
| `Range` | No | e.g. `bytes=0-1048575` |
| `Origin` | Browser | Must be listed in `ALLOWED_ORIGINS` |

**Success**

- `200 OK` — full resource
- `206 Partial Content` — ranged body with `Content-Range`

**Errors**

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_VIDEO_ID` | Bad `:videoId` |
| 401 | `UNAUTHORIZED` | Missing/invalid proxy API key |
| 403 | `UPSTREAM_FORBIDDEN` | Provider denied access |
| 404 | `VIDEO_NOT_FOUND` | Unknown video |
| 416 | `RANGE_NOT_SATISFIABLE` | Invalid range |
| 502 | `UPSTREAM_*` | Provider/auth/connection failure |
| 504 | `UPSTREAM_TIMEOUT` | Provider too slow |

### `HEAD /api/videos/:videoId`

Same auth and validation as `GET`, returns headers only when the upstream supports `HEAD`.

### `GET /api/videos/stream?url=`

Streams a **full upstream URL**. Host policy depends on `URL_PROXY_MODE`:

- **`any`** (recommended for many CDNs): any public `https` host; **`PROXY_API_KEY` required**
- **`allowlist`**: host must be in `ALLOWED_UPSTREAM_HOSTS` / `VIDEO_PROVIDER_BASE_URL`

**Query**

| Param | Required | Description |
|---|---|---|
| `url` | Yes | Absolute `http(s)` video URL (URL-encoded) |

**Security rules**

- Requires proxy API key when `URL_PROXY_MODE=any` (not a public open proxy)
- Blocks localhost, private/link-local IPs, metadata hosts; DNS answers are checked
- Rejects URLs with embedded credentials
- Production requires `https`
- Provider token / extra headers only when host matches `VIDEO_PROVIDER_BASE_URL`
- Fixed `VIDEO_PROVIDER_REFERER` is sent on all upstream fetches
- Upstream redirects are not followed automatically

**Example**

```text
GET /api/videos/stream?url=https%3A%2F%2Fhls.dramahot.top%2Ffolder%2Fvideo.mp4
```

**Angular**

```ts
const upstream = 'https://hls.dramahot.top/folder/video.mp4';
this.videoUrl = `http://localhost:3000/api/videos/stream?url=${encodeURIComponent(upstream)}`;
```

```html
<video controls preload="metadata" [src]="videoUrl"></video>
```

### `HEAD /api/videos/stream?url=`

Same as GET stream, headers only.

## How video streaming works

1. Angular requests either `/api/videos/:videoId` or `/api/videos/stream?url=...`.
2. The proxy validates origin, rate limits, API key, and target (ID format or allowlisted URL).
3. ID mode builds the upstream URL from `VIDEO_PROVIDER_BASE_URL` + path template. URL mode uses the provided URL after host checks.
4. The proxy adds **server-side** provider credentials when appropriate and forwards `Range`.
5. Upstream bytes are piped to the client with Node streams (`Readable.fromWeb` → `pipe`).
6. If the client disconnects, an `AbortController` cancels the upstream fetch.

### How Range requests work

Browsers seek by sending:

```http
Range: bytes=1000000-1999999
```

The proxy forwards that header upstream. A compliant provider responds:

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 1000000-1999999/5000000
Content-Length: 1000000
Accept-Ranges: bytes
```

Those headers are forwarded to the browser so `<video>` seeking works. The proxy never downloads the entire file into memory.

## Angular integration

Do **not** call the video provider from the browser. Point the player at the proxy.

```typescript
// environment.ts
export const environment = {
  videoProxyBaseUrl: 'https://video-proxy.yourdomain.com',
  // Prefer injecting the proxy API key via a short-lived backend session
  // rather than shipping a long-lived key in the SPA if possible.
};
```

```typescript
// video-player.component.ts
import { Component, Input } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-video-player',
  template: `
    <video controls preload="metadata" width="100%" [src]="videoUrl"></video>
  `,
})
export class VideoPlayerComponent {
  @Input() videoId!: string;
  videoUrl!: SafeUrl;

  constructor(private sanitizer: DomSanitizer) {}

  ngOnChanges(): void {
    // If the API key must be sent as a query param for <video>, prefer a
    // same-origin BFF that attaches Authorization instead. Cookie-based
    // session auth to the proxy is another option.
    const url = `${environment.videoProxyBaseUrl}/api/videos/${encodeURIComponent(this.videoId)}`;
    this.videoUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }
}
```

HTML equivalent:

```html
<video controls preload="metadata" width="100%">
  <source [src]="videoUrl" type="video/mp4" />
</video>
```

Example URL:

```text
https://video-proxy.yourdomain.com/api/videos/123
```

**Note on `<video>` and API keys:** The native video element cannot set `Authorization` headers. Options:

1. Same-origin reverse proxy (Nginx) that injects the key to the Node app.
2. Short-lived cookie session issued by your BFF after user login.
3. Signed, expiring proxy URLs generated by your Angular backend (recommended for public players).

For local demos you can temporarily disable `PROXY_API_KEY` in development only (empty key skips auth outside production).

## Production deployment

1. Set `NODE_ENV=production`.
2. Use a strong `PROXY_API_KEY` (≥ 16 characters) and rotate provider tokens regularly.
3. Restrict `ALLOWED_ORIGINS` to real frontends (`https://mac.video.com`).
4. Run behind HTTPS termination (Nginx / load balancer).
5. Use a process manager (`systemd`, PM2) and health checks on `/health`.
6. Scale horizontally; the proxy is stateless.
7. Monitor 4xx/5xx rates and upstream latency from structured logs (`requestId`, `videoId`, `upstreamStatus`, `durationMs`).

```bash
NODE_ENV=production npm start
```

### Nginx reverse proxy

```nginx
upstream video_proxy {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name video-proxy.yourdomain.com;

    # ssl_certificate     /etc/ssl/certs/fullchain.pem;
    # ssl_certificate_key /etc/ssl/private/privkey.pem;

    client_max_body_size 1m;

    location /health {
        proxy_pass http://video_proxy;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Request-Id $request_id;
    }

    location /api/videos/ {
        proxy_pass http://video_proxy;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Range $http_range;
        proxy_set_header If-Range $http_if_range;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-API-Key $http_x_api_key;
        proxy_set_header X-Request-Id $request_id;

        # Critical for streaming / seeking
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_max_temp_file_size 0;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Optional: inject proxy API key at the edge so the SPA needs no key
        # proxy_set_header X-API-Key "your-proxy-api-key";
    }
}
```

## Troubleshooting

### 401 Unauthorized

- Missing or wrong `X-API-Key` / `Authorization: Bearer` for the **proxy**.
- Confirm `PROXY_API_KEY` matches what the client or Nginx sends.
- Provider `401` is mapped to **502** `UPSTREAM_UNAUTHORIZED` (misconfigured server-side token), not client 401.

### 403 Forbidden

- Browser `Origin` not listed in `ALLOWED_ORIGINS`.
- Or upstream returned 403 (`UPSTREAM_FORBIDDEN`) — video entitlement / provider ACL issue. Fix provider permissions; do not spoof Referer.

### 404 Not Found

- Unknown route, or video ID does not exist upstream (`VIDEO_NOT_FOUND`).
- Verify `VIDEO_PROVIDER_PATH_TEMPLATE` expands to the correct provider path.

### 502 Bad Gateway

- Upstream connection failure, unexpected status, redirect, or provider auth failure.
- Check proxy logs for `upstreamStatus`, `upstreamHost`, and `code` (never log tokens).
- Verify DNS, TLS, firewall, and that `VIDEO_PROVIDER_BASE_URL` is reachable from the proxy host.

### 504 Upstream Timeout

- Increase `UPSTREAM_TIMEOUT` if cold starts are slow, or investigate provider latency.
- Ensure Nginx `proxy_read_timeout` is not shorter than your streaming needs for long plays (separate from fetch timeout for the initial response).

### Seeking does not work

- Confirm upstream returns `206` + `Content-Range` + `Accept-Ranges: bytes`.
- Ensure Nginx has `proxy_buffering off` and forwards `Range`.

## Testing

```bash
npm test
```

Coverage includes:

- Health endpoint (no secret leakage)
- Valid video stream
- Invalid video ID
- Unauthorized proxy access
- Upstream 403 / 404
- Range → 206 Partial Content
- Upstream 416
- HEAD support
- Upstream timeout
- Client disconnection / abort
- Allowlisted full-URL streaming
- Rejected non-allowlisted URL hosts

Upstream HTTP is mocked via `global.fetch` — tests do not call a real provider.

## Security notes

- No open / arbitrary URL proxying
- Provider credentials stay on the server
- Input validation limits `:videoId` to `[A-Za-z0-9._-]{1,128}`
- Helmet + CORS + rate limit + proxy auth
- Logs redact `authorization`, `token`, `apiKey`, and similar fields

## License

MIT
