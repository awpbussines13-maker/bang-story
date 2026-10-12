# Bang Story Web Version Implementation Plan

**Goal:** Transform Bang Story from an Electron-wrapped desktop app into a lightweight, standalone web application deployable on VPS via Docker without VNC/virtual desktop overhead.

**Architecture:**
- **Backend:** Node.js HTTP server hosting JSON-RPC (`/api/rpc`), Server-Sent Events (`/api/events`), static file streaming with HTTP Range support (`/api/asset/*`, `/api/fonts/*`), and file uploads (`/api/upload`). Reuses 100% of the existing TypeScript domain services (SQLite repo, LLM story generation, TTS narration, Higgsfield generation, and FFmpeg exporter).
- **Frontend:** React 19 + Tailwind v4 + Zustand SPA built via Vite into `out/renderer`, coupled with a universal client-side RPC bridge (`api-bridge.js`) that fulfills `window.api` using native browser `fetch`, `EventSource`, and `<input type="file">`.
- **Deployment:** Minimal `Dockerfile.web` (~300MB) running `node dist/server.js` directly, exposed via standard HTTP port (e.g. 3000), reverse-proxied by Nginx.

---

### Step 1: Decouple Core Main Process from Electron
- Decouple `src/main/paths.ts` to support `DATA_DIR` and fallback to `join(process.cwd(), 'data')`.
- Decouple `src/main/events.ts` to broadcast via `EventEmitter` for Web SSE while keeping Electron IPC support.
- Decouple `src/main/secrets.ts` and `src/main/whisper.ts` from hard Electron imports using safe dynamic requires.
- Refactor `src/main/ipc.ts` to register handlers into an exported `handlers` map and add `dispatch(channel, args)`.

### Step 2: Implement Standalone Web Server
- Create `src/server/index.ts` using Node.js native HTTP:
  - `POST /api/rpc`: executes `dispatch(channel, args)` and returns JSON.
  - `GET /api/events`: SSE stream hooked into `eventBus` (emitting `job`, `clip`, `character`, `asset`, `whisper`).
  - `GET /api/asset/*`: serves files from `projectsRoot()` with HTTP 206 Partial Content support.
  - `GET /api/fonts/*`: serves TTF fonts from `resources/fonts/`.
  - `POST /api/upload`: handles multipart/form-data or binary upload for `pickMusic` and `pickImage`.
  - `GET /api/download`: serves rendered MP4 files for direct download.
  - Serves static assets from `out/renderer` (HTML, CSS, JS).

### Step 3: Implement Web RPC Client Bridge
- Create `src/renderer/src/api-bridge.ts` (and compile to public `api-bridge.js`):
  - Emulates `window.api` with JavaScript `Proxy` forwarding calls to `POST /api/rpc`.
  - Implements `window.api.on.*` using `new EventSource('/api/events')`.
  - Implements `window.api.assets.pickMusic` and `pickImage` via hidden `<input type="file">` and `fetch('/api/upload')`.
  - Implements `window.api.exporter.reveal` by downloading the MP4 in the browser.
  - Implements `window.api.app.copyText` and `openExternal` via web APIs.

### Step 4: Fix Font and Asset URLs
- Replace `studio://fonts/` in `src/renderer/src/styles.css` with `/api/fonts/` (compatible with both web and Electron).
- Ensure `assetUrl()` returns `/api/asset/${rel}` when `WEB_MODE=1`.

### Step 5: Build and Containerization
- Add build script `build:web` (compiles Vite renderer and TypeScript server).
- Create lightweight `Dockerfile.web` based on `node:22-bookworm-slim` (no X11, no VNC, no GTK).
- Create `docker-compose.web.yml` exposing port 3009.
- Verify container startup, resource usage, and web UI in browser.
