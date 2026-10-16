# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO (object storage):** `curl -f http://localhost:9000/minio/health/live` — expect HTTP 200
- **Bucket bootstrap:** `docker compose ps -a minio-init` — expect `exited (0)` (one-shot that creates the buckets)
- **Redis (queue):** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

The `video-worker` container starts with `docker compose up -d` and runs its own watch build (`start:worker:dev`); it is part of the environment, unlike the API dev server.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (image `Dockerfile.dev`, includes `ffmpeg` so the test suites run the real media pipeline)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, API `9000`, console `9001`, root user `streamtube` / `streamtube-secret` (image `bitnamilegacy/minio`: the official `minio/minio` images are no longer published)
- `minio-init` — one-shot that creates the buckets `streamtube-videos`, `streamtube-thumbnails`, `streamtube-videos-test`, `streamtube-thumbnails-test`
- `redis` — Redis 7 for the BullMQ queue, port `6379`
- `video-worker` — video processing worker (image `Dockerfile.worker`, Node + `ffmpeg`), same source tree as the API, no HTTP port

After changing `Dockerfile.dev` or `Dockerfile.worker`, rebuild: `docker compose build nestjs-api video-worker && docker compose up -d`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/ (API and worker entrypoints)
npm run start:prod                       # Run compiled build
npm run start:worker                     # Run the compiled video worker (dist/worker/main)
npm run migration:run                    # Apply pending migrations
npm run openapi:export                   # Regenerate openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

The video worker's watch build (`start:worker:dev`, run by the `video-worker` container) uses `tsconfig.worker.json` and emits to `dist-worker/`, so it never clobbers the API's `dist/` (both builds use `deleteOutDir`).

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## Videos module

Phase 03 (plan: `docs/phases/phase-03-videos/phase-03-videos.md`). Every route requires the JWT (no `@Public()`); errors use the shared `{ statusCode, error, message }` envelope.

| Endpoint | Purpose | Main errors |
|----------|---------|-------------|
| `POST /videos` | Pre-register a draft and start a multipart upload; returns `uploadId`, `partSize` and one presigned `PUT` URL per part (max 10GB, allowed types `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`) | 400, 401 |
| `POST /videos/:id/upload/complete` | Complete the multipart with `{ parts: [{ partNumber, etag }] }`, verify the real size, move to `processing` and enqueue the job | 404 `VIDEO_NOT_FOUND`, 409 `INVALID_VIDEO_STATE`, 422 `UPLOAD_COMPLETION_FAILED` / `UPLOAD_SIZE_MISMATCH` |
| `GET /videos/:publicId` | Read a video by its unique 11-char public id (status, metadata, presigned `thumbnailUrl`) | 404 `VIDEO_NOT_FOUND` |
| `GET /videos/:publicId/stream` | Short-lived presigned GET for playback (storage serves `Range` / 206) | 404, 409 `VIDEO_NOT_READY` |
| `GET /videos/:publicId/download` | Same, signed with `Content-Disposition: attachment` | 404, 409 `VIDEO_NOT_READY` |

Only the channel owner can access a video in this phase; other users get 404.

Components:

- `src/videos/` — `VideosController`, `VideosService` (upload handshake, ownership, playback URLs), `Video` entity (`videos` table, migration `1792171312702-CreateVideos`), `public-id.util.ts`, DTOs.
- `src/storage/` — `StorageService` over `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (multipart, presigning, `HeadObject`, put/delete). Buckets come from `STORAGE_VIDEOS_BUCKET` / `STORAGE_THUMBNAILS_BUCKET`; keys are `{videoId}/source` and `{videoId}/default.jpg`.
- `src/queue/` — `QueueModule` (`@nestjs/bullmq` 11.x, CommonJS; `bullmq` 6 + `ioredis`), registers the `video-processing` queue under `QUEUE_PREFIX`.
- `src/media/` — `MediaProbeService`: spawns the system `ffprobe` / `ffmpeg` (metadata + JPEG frame), input may be a presigned URL.
- `src/videos/processing/` — `VideoProcessingQueue` (producer, `jobId: process-{videoId}`, 3 attempts, exponential backoff), `VideoProcessingService` (`process`, `markFailed`, `reconcileStuck`), `VideoProcessingConsumer` (`@Processor`, jobs `process` and `reconcile`), `ReconcileScheduler`. `VideoProcessingModule` is **not** imported by `AppModule`: the API only produces jobs.
- `src/worker/` — `main.ts` (`NestFactory.createApplicationContext`) and `WorkerModule` for the `video-worker` container.
- Shared bootstrap: `src/config/config-module.options.ts` and `src/database/typeorm-options.factory.ts` are used by both `AppModule` and `WorkerModule`.

Status lifecycle: `uploading → processing → ready | error`; `processing_error` holds `UPLOAD_SIZE_MISMATCH`, `NO_VIDEO_STREAM`, `PROBE_FAILED` or `THUMBNAIL_FAILED`. Config keys (`STORAGE_*`, `REDIS_*`, `QUEUE_PREFIX`, `VIDEO_RECONCILE_*`) are validated in `src/config/env.validation.ts`; see `.env.example`.

Testing against the real services: suites use the `*-test` buckets (`useTestStorageBuckets()` in `src/test/storage.ts`) and a test queue prefix (`useTestQueuePrefix()` in `src/test/queue.ts`; E2E uses `streamtube-e2e` via `test/support/e2e-app.ts`), so they never touch the worker's `streamtube` jobs. Media fixtures live in `test/fixtures/` (`sample.mp4`, `audio-only.m4a`). Specs for the controller E2E suites are in `specs/`.

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
