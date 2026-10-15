---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T04:12:04-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-15T04:35:23-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-video-processing-job-delivery.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-03T20:19:34-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB direto ao object storage, sem passar pela API. O vídeo é pré-cadastrado como rascunho ao iniciar o upload. Depois do upload, uma fila e um worker de vídeo processam o arquivo automaticamente: extraem duração e metadados e geram a thumbnail a partir de um frame. Cada vídeo tem uma URL única e sem conflito, e pode ser reproduzido por streaming (sem download completo) ou baixado.

---

## Step Implementations

### SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila

**Description:** Sobe o object storage (MinIO) e o broker da fila (Redis) no Compose, com os buckets e o CORS prontos, e adiciona a configuração tipada e validada que storage, fila e worker vão consumir.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml`: o serviço `minio` (`minio/minio`, `server /data --console-address :9001`, portas `9000`/`9001`, volume `minio-data`, healthcheck em `/minio/health/live`); o serviço one-shot `minio-init` (`minio/mc`), que cria os buckets `streamtube-videos`, `streamtube-thumbnails`, `streamtube-videos-test` e `streamtube-thumbnails-test` e aplica nos buckets de vídeo um CORS com `PUT`/`GET` e `ExposeHeaders: ETag`; e o serviço `redis` (`redis:7-alpine`, healthcheck `redis-cli ping`). O `nestjs-api` passa a depender de `minio` (healthy), `minio-init` (completed) e `redis` (healthy). Hosts sempre pelo nome do serviço do Compose (per phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-06)
2. Instalar no container `@aws-sdk/client-s3@^3.1152.0`, `@aws-sdk/s3-request-presigner@^3.1152.0`, `bullmq@^6.3.15` e `@nestjs/bullmq@^12.0.0` (versões do `library-refs.md`; per phase-03-videos/TD-01, phase-03-videos/TD-06)
3. Criar `src/config/storage.config.ts` (`registerAs('storage', …)`: `endpoint`, `region`, `accessKeyId`, `secretAccessKey`, `forcePathStyle`, `videosBucket`, `thumbnailsBucket`, `uploadPartSizeBytes`, `uploadUrlTtlSeconds`, `playbackUrlTtlSeconds`) e `src/config/queue.config.ts` (`registerAs('queue', …)`: `redisHost`, `redisPort`, `prefix`, `reconcileIntervalMs`, `reconcileStuckAfterMs`), injetados via `ConfigType` (convenção herdada `registerAs` da Fase 01; per phase-01-configuracao-base/TD-03)
4. Estender `src/config/env.validation.ts` (Joi) e `.env`/`.env.example` com `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY` e `STORAGE_SECRET_KEY` (required), `STORAGE_FORCE_PATH_STYLE` (default `true`), `STORAGE_VIDEOS_BUCKET` (default `streamtube-videos`), `STORAGE_THUMBNAILS_BUCKET` (default `streamtube-thumbnails`), `STORAGE_UPLOAD_PART_SIZE_BYTES` (default `67108864`, min `5242880`), `STORAGE_UPLOAD_URL_TTL_SECONDS` (default `21600`), `STORAGE_PLAYBACK_URL_TTL_SECONDS` (default `3600`), `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `streamtube`), `VIDEO_RECONCILE_INTERVAL_MS` (default `300000`) e `VIDEO_RECONCILE_STUCK_AFTER_MS` (default `900000`) (per phase-01-configuracao-base/TD-02)
5. Registrar `storageConfig` e `queueConfig` no `load` do `ConfigModule.forRoot` do `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (novas chaves de storage/fila) | Integration: defaults aplicados, required ausente rejeitado, `STORAGE_UPLOAD_PART_SIZE_BYTES` < 5MiB rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` como `healthy` e termina `minio-init` com exit code `0`
- `mc ls` no MinIO lista os buckets `streamtube-videos`, `streamtube-thumbnails`, `streamtube-videos-test` e `streamtube-thumbnails-test`
- Um preflight `OPTIONS` com `Origin` em `http://minio:9000/streamtube-videos/...` retorna `Access-Control-Expose-Headers` contendo `ETag`
- `docker compose exec redis redis-cli ping` retorna `PONG`
- Subir a aplicação sem `STORAGE_ACCESS_KEY` falha no boot com erro de validação de env que cita a chave

---

### SI-03.2 — Implementar StorageModule (cliente S3 + URLs pré-assinadas)

**Description:** Encapsula o object storage atrás de um `StorageService` com as operações que upload, worker e streaming usam: multipart, pré-assinatura, `HeadObject`, gravação da thumbnail e remoção.

**Technical actions:**

1. Criar `src/storage/storage.module.ts`, que provê um `S3Client` via factory a partir de `storageConfig` (`endpoint`, `region`, `credentials`, `forcePathStyle: true` para o MinIO) e exporta `StorageService` (per phase-03-videos/TD-01; `library-refs.md` → `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` com o bucket lógico `'videos' | 'thumbnails'` mapeado para `videosBucket`/`thumbnailsBucket`: `createMultipartUpload(key, contentType)` → `uploadId`; `presignUploadParts(key, uploadId, partCount, ttlSeconds)` → `{ partNumber, url }[]` (`UploadPartCommand` + `getSignedUrl`); `completeMultipartUpload(key, uploadId, parts)` (ordena por `PartNumber`); `abortMultipartUpload(key, uploadId)`; `headObject(bucket, key)` → `{ contentLength, contentType } | null` (per phase-03-videos/TD-03, phase-03-videos/TD-05)
3. Adicionar ao `StorageService`: `presignGet(bucket, key, ttlSeconds, { contentDisposition? })` (`GetObjectCommand` com `ResponseContentDisposition`), `putObject(bucket, key, body, contentType)` e `deleteObject(bucket, key)` (per phase-03-videos/TD-09, phase-03-videos/TD-11; `library-refs.md` → `@aws-sdk/s3-request-presigner`)
4. Criar `src/test/storage.ts` com o helper de teste que aponta para `streamtube-videos-test`/`streamtube-thumbnails-test` e limpa os objetos por prefixo ao fim de cada suíte (isolamento por bucket de teste; per phase-03-videos/TD-13)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart completo via PUT nas URLs pré-assinadas, `HeadObject`, GET com `Range` → `206`, `Content-Disposition` no download, abort/delete | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation (DI do `S3Client` + config) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO, buckets de teste e `storageConfig` precisam existir)

**Acceptance criteria:**

- Um `PUT` HTTP numa URL de `presignUploadParts` retorna `200` com header `ETag`
- `completeMultipartUpload` com as partes enviadas produz um objeto cujo `HeadObject.ContentLength` é a soma dos bytes das partes
- Um `GET` com `Range: bytes=0-99` numa URL de `presignGet` retorna `206 Partial Content` com exatamente 100 bytes
- A URL de `presignGet` com `contentDisposition` retorna `Content-Disposition: attachment; filename="..."`
- Depois de `abortMultipartUpload`, `headObject` na mesma chave retorna `null`

---

### SI-03.3 — Criar entidade Video, migration CreateVideos e gerador de public_id

**Description:** Materializa a tabela `videos` ligada ao canal, com o ciclo de status e a dimensão de publicação separados, e o gerador do identificador público curto e sem colisão.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`) com os campos do `### Data Model → Video`, os enums `VideoStatus` (`uploading`, `processing`, `ready`, `error`) e `VideoPublicationStatus` (`draft`) e a relação `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, unidirecional, sem tocar em `Channel` (per phase-03-videos/TD-12 + Revision 2026-10-15; AMB-3)
2. Criar `src/database/migrations/<timestamp>-CreateVideos.ts`: tipos `video_status` e `video_publication_status`, tabela `videos`, FK `channel_id → channels(id) ON DELETE CASCADE`, `CHECK (declared_size_bytes > 0 AND declared_size_bytes <= 10737418240)`, unique em `public_id` e índices em `channel_id` e `(status, updated_at)`. O `down` remove tabela e tipos (per phase-03-videos/TD-05, video-processing-job-delivery/TD-01)
3. Criar `src/videos/public-id.util.ts` com `generatePublicId()`: 11 caracteres do alfabeto `[0-9A-Za-z]` sobre `crypto.randomBytes`, com amostragem por rejeição (descarta bytes ≥ 248 para eliminar o viés de módulo) (per phase-03-videos/TD-10)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo no `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`uploading`/`draft`), unique `public_id`, `CHECK` de tamanho, cascade ao apagar o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: comprimento 11, alfabeto base62, unicidade em 10.000 amostras | `src/videos/public-id.util.spec.ts` |
| `CreateVideos` | Integration: `up` cria `videos` e os tipos; o revert da última migration remove `videos` (ajusta a asserção atual "revert remove token tables") | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um vídeo sem `status`/`publication_status` persiste `status = 'uploading'` e `publication_status = 'draft'`
- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique
- Inserir um vídeo com `declared_size_bytes = 10737418241` viola o `CHECK`
- Apagar um canal remove os vídeos dele
- `npm run migration:revert` logo após aplicar `CreateVideos` remove a tabela `videos` e os dois tipos enum
- `generatePublicId()` sempre retorna um valor que casa com `/^[0-9A-Za-z]{11}$/`

---

### SI-03.4 — Endpoint POST /videos (pré-cadastro em rascunho + início do multipart)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated — cria no canal do próprio usuário (per `### Authorization Matrix`)

**Description:** Cria o vídeo como rascunho no instante em que o upload começa e devolve as URLs pré-assinadas das partes, sem que nenhum byte passe pela API.

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` → `Channel | null` no `ChannelsModule`. É dono da consulta de canal; o módulo de vídeos não lê `channels` direto (Single Responsibility)
2. Criar `src/videos/dto/create-video.dto.ts` (`title`, `fileName`, `contentType`, `fileSize` per `### API Contracts → #### Validation Rules — vídeos`) e `src/videos/dto/create-video-response.dto.ts` (`id`, `publicId`, `status`, `publicationStatus`, `uploadId`, `partSize`, `parts`, `expiresAt`), com `@ApiProperty` (per openapi-docs-nestjs/TD-01)
3. Criar `VideosService.createUpload(userId, dto)` em `src/videos/videos.service.ts`, nesta ordem: resolve o canal; gera `id` (`crypto.randomUUID()`) e `public_id` (`generatePublicId`, até 3 tentativas em violação de unique); `partCount = ceil(fileSize / uploadPartSizeBytes)`; `storage.createMultipartUpload('{id}/source', contentType)`; persiste a linha (`status = 'uploading'`, `upload_id`, `source_key`, `declared_size_bytes`, `original_filename`); se a persistência falhar, chama `abortMultipartUpload`; por fim pré-assina as partes. Nenhuma URL além de `partCount` (per phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-10)
4. Criar `src/videos/videos.controller.ts` com `POST /videos` (`@CurrentUser()`, `201`), documentado com `@ApiOperation`, `@ApiBody`, `@ApiResponse(201/400/401)` e `ApiErrorEnvelope` (per openapi-docs-nestjs/TD-01)
5. Importar `ChannelsModule` e `StorageModule` no `VideosModule` e registrar o controller e o `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createUpload` | Unit (mock repo/storage/channels): cálculo de `partCount`, retry de `public_id`, abort do multipart quando a persistência falha | `src/videos/videos.service.spec.ts` |
| `VideosService.createUpload` | Integration (DB + MinIO reais): linha persistida com `upload_id`/`source_key` e multipart criado no bucket de teste | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (multipart e pré-assinatura), SI-03.3 (entidade `Video` e `generatePublicId`)

**Acceptance criteria:**

- `POST /videos` com `{ title, fileName, contentType: "video/mp4", fileSize: 200000000 }` válido retorna `201` com `status: "uploading"`, `publicationStatus: "draft"`, `uploadId` e `parts` com `ceil(200000000 / partSize)` itens
- Depois do `201`, existe uma linha em `videos` com `status = 'uploading'`, `publication_status = 'draft'` e `channel_id` igual ao canal do usuário
- `POST /videos` com `contentType: "video/avi"` retorna `400`
- `POST /videos` com `fileSize: 10737418241` retorna `400`
- `POST /videos` sem token retorna `401`
- Cada URL de `parts[]` aceita um `PUT` direto no storage e responde com `ETag`

---

### SI-03.5 — Implementar módulo de fila e produtor VideoProcessingQueue

**Description:** Conecta o NestJS ao Redis via `@nestjs/bullmq` e expõe um produtor único do job `process`, com `jobId` determinístico e política de retentativa. É a base da garantia de entrega e do worker.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (conexão `{ host: redisHost, port: redisPort }` e `prefix` vindos de `queueConfig`) e `BullModule.registerQueue({ name: 'video-processing' })`, exportando o `BullModule` (per phase-03-videos/TD-06; `library-refs.md` → `@nestjs/bullmq`)
2. Criar `src/videos/processing/video-processing.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, os nomes de job `process`/`reconcile` e as opções `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }` (per `### Events/Messages`)
3. Criar `src/videos/processing/video-processing.queue.ts` (`VideoProcessingQueue`, `@InjectQueue('video-processing')`) com `enqueueProcess(videoId)` → `queue.add('process', { videoId }, { jobId: 'process-{videoId}', ... })` (per video-processing-job-delivery/TD-01; `library-refs.md` → `bullmq` → "Job IDs")
4. Importar `QueueModule` no `VideosModule` e prover/exportar `VideoProcessingQueue`. As suítes de teste sobrescrevem `QUEUE_PREFIX` com um prefixo de teste, para que jobs de teste nunca cheguem ao worker real (per phase-03-videos/TD-13)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueue` | Integration (Redis real, prefixo de teste): job `process` criado com `jobId`, `attempts` e `backoff`; segundo `enqueueProcess` com job ainda na fila não duplica | `src/videos/processing/video-processing.queue.integration-spec.ts` |
| `QueueModule` | Unit: compilation com `BullModule.forRootAsync` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 (Redis e `queueConfig`), SI-03.3 (`VideosModule` existe)

**Acceptance criteria:**

- `enqueueProcess(id)` cria na fila `video-processing` um job `process` com id `process-{id}`, dados `{ videoId: id }` e `attempts = 3`
- Chamar `enqueueProcess(id)` duas vezes enquanto o primeiro job está na fila resulta em um único job (`getJobCounts` inalterado)
- Jobs enfileirados com o prefixo de teste não aparecem na fila sob o prefixo `streamtube`

---

### SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + verificação + enfileiramento)

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)

**Description:** Fecha o handshake de upload do lado do servidor: conclui o multipart, impõe o limite real de tamanho e transiciona o vídeo para `processing`, enfileirando o processamento depois do commit.

**Technical actions:**

1. Adicionar a `src/common/exceptions/domain.exception.ts`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidVideoStateException` (`INVALID_VIDEO_STATE`, 409), `UploadCompletionFailedException` (`UPLOAD_COMPLETION_FAILED`, 422) e `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422) (per `### Error Catalog`, phase-02-auth/TD-07)
2. Criar `src/videos/dto/complete-upload.dto.ts` (`parts: { partNumber, etag }[]`, 1–10000, `@ValidateNested`) e `src/videos/dto/complete-upload-response.dto.ts` (`id`, `publicId`, `status`)
3. Implementar `VideosService.completeUpload(userId, id, parts)`: carrega o vídeo do canal do usuário (senão `VideoNotFoundException`); exige `status = 'uploading'` (senão `InvalidVideoStateException`); `storage.completeMultipartUpload`, mapeando a rejeição do storage (`InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`) para `UploadCompletionFailedException` sem mudar o status (per phase-03-videos/TD-04)
4. Na mesma operação: `storage.headObject`. Se `ContentLength ≠ declared_size_bytes`, aplica `deleteObject` e persiste `status = 'error'`, `processing_error = 'UPLOAD_SIZE_MISMATCH'`, `upload_id = NULL`, e lança `UploadSizeMismatchException`. Senão, persiste `status = 'processing'`, `size_bytes`, `upload_id = NULL` e, **só depois do commit**, chama `VideoProcessingQueue.enqueueProcess(id)`. Uma falha de enfileiramento é registrada em log e coberta pela varredura de SI-03.9 (per phase-03-videos/TD-05, video-processing-job-delivery/TD-01)
5. Adicionar ao `VideosController` o `POST /videos/:id/upload/complete` (`ParseUUIDPipe`, `200`), com `@ApiResponse(200/400/401/404/409/422)` (per openapi-docs-nestjs/TD-01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks): ramos não-dono, estado inválido, rejeição do storage, divergência de tamanho; enfileiramento só depois do commit | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): conclusão vai a `processing` e cria o job `process-{id}`; divergência apaga o objeto e grava `error` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (vídeo em `uploading` com `upload_id`), SI-03.5 (`VideoProcessingQueue`)

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` do dono, com todas as partes e `ETag`s corretos, retorna `200` com `status: "processing"`, e a fila `video-processing` passa a ter o job `process-{id}`
- Concluir um vídeo cujo `ContentLength` real difere do `fileSize` declarado retorna `422 UPLOAD_SIZE_MISMATCH`; o objeto deixa de existir no bucket e a linha fica com `status = 'error'` e `processing_error = 'UPLOAD_SIZE_MISMATCH'`
- Concluir com uma parte faltando retorna `422 UPLOAD_COMPLETION_FAILED`, e o vídeo continua em `uploading`
- Concluir de novo um vídeo já em `processing` retorna `409 INVALID_VIDEO_STATE`
- Concluir o vídeo de outro canal retorna `404 VIDEO_NOT_FOUND`
- `:id` que não é uuid retorna `400`

---

### SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg via child_process)

**Description:** Isola a invocação do FFmpeg num serviço próprio, que extrai duração/metadados e um frame JPEG a partir de uma URL ou arquivo, para o worker consumir.

**Technical actions:**

1. Instalar `ffmpeg` (pacote do SO, que traz `ffprobe`) no `nestjs-project/Dockerfile.dev`, para que as suítes que rodam no `nestjs-api` executem o FFmpeg de verdade (per phase-03-videos/TD-08, phase-03-videos/TD-13)
2. Gerar com `ffmpeg` e versionar os fixtures `test/fixtures/sample.mp4` (≈2s, 320×240, H.264, < 300KB) e `test/fixtures/audio-only.m4a` (sem stream de vídeo) (per phase-03-videos/TD-13)
3. Criar `src/media/media-probe.service.ts` com `probe(input)`: faz spawn de `ffprobe -v error -print_format json -show_format -show_streams <input>` com timeout, interpreta a saída em `ProbeResult` (`durationSeconds`, `width`, `height`, `formatName`, `raw`) por uma função pura `parseProbeOutput` e lança `NoVideoStreamError` quando não há stream `codec_type = 'video'` (per phase-03-videos/TD-08)
4. Adicionar `extractThumbnail(input, atSeconds)`: spawn de `ffmpeg -ss <t> -i <input> -frames:v 1 -f image2 -vcodec mjpeg pipe:1` → `Buffer` JPEG, com timeout. A entrada pode ser uma URL GET pré-assinada, lida por `Range` sem disco de rascunho (per phase-03-videos/TD-08, phase-03-videos/TD-09)
5. Criar `src/media/media.module.ts`, que exporta o `MediaProbeService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: JSON do ffprobe → `ProbeResult`; ausência de stream de vídeo → `NoVideoStreamError` | `src/media/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration (ffmpeg real + MinIO): `probe`/`extractThumbnail` no fixture local e sobre URL pré-assinada do bucket de teste | `src/media/media-probe.service.integration-spec.ts` |
| `MediaModule` | Unit: compilation | `src/media/media.module.spec.ts` |

**Dependencies:** SI-03.2 (URL pré-assinada para o teste de leitura por `Range`)

**Acceptance criteria:**

- `probe` sobre `sample.mp4` retorna `durationSeconds` ≈ 2.0, `width = 320`, `height = 240` e `formatName` contendo `mp4`
- `probe` sobre `audio-only.m4a` lança `NoVideoStreamError`
- `extractThumbnail` sobre `sample.mp4` retorna um buffer não vazio que começa com os bytes JPEG `FF D8`
- `probe` sobre a URL GET pré-assinada do objeto no MinIO retorna os mesmos metadados que sobre o arquivo local
- `ffprobe -version` executa com sucesso dentro do container `nestjs-api`

---

### SI-03.8 — Implementar processamento do vídeo (VideoProcessingService + consumer)

**Description:** Consome o job `process`: extrai metadados, gera e grava a thumbnail e leva o vídeo a `ready`. Falhas definitivas viram `error` com motivo. É o núcleo do processamento automático.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.service.ts` com `process(videoId)`: carrega o vídeo; se `status ≠ 'processing'`, termina sem efeito (idempotência); gera `presignGet('videos', source_key, ttl)` e chama `MediaProbeService.probe(url)`. `NoVideoStreamError` grava `status = 'error'` e `processing_error = 'NO_VIDEO_STREAM'` e lança `UnrecoverableError` do `bullmq` (per phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-12)
2. Ainda em `process`: `extractThumbnail(url, min(1, durationSeconds / 2))` → `storage.putObject('thumbnails', '{videoId}/default.jpg', buffer, 'image/jpeg')`; depois persiste `duration_seconds`, `width`, `height`, `format_name`, `probe_metadata`, `thumbnail_key`, `status = 'ready'` e `processed_at` (per phase-03-videos/TD-02, phase-03-videos/TD-08; AMB-3)
3. Adicionar `markFailed(videoId, reason)`. O estágio que falhou define o motivo: `PROBE_FAILED` (probe) ou `THUMBNAIL_FAILED` (extração ou upload da thumbnail) (per `### Error Catalog → Motivos de falha do processamento`)
4. Criar `src/videos/processing/video-processing.consumer.ts` (`@Processor('video-processing')`, estende `WorkerHost`), que roteia por `job.name` (`process` → `process(videoId)`) e, em `@OnWorkerEvent('failed')`, chama `markFailed` só quando `job.attemptsMade >= job.opts.attempts` (tentativas esgotadas; per phase-03-videos/TD-06, phase-03-videos/TD-12; `library-refs.md` → `bullmq` → "Retentativa", `@nestjs/bullmq` → "Produtor e consumidor")
5. Criar `src/videos/processing/video-processing.module.ts` importando `TypeOrmModule.forFeature([Video])`, `StorageModule`, `MediaModule` e `QueueModule`, e provendo `VideoProcessingService` e `VideoProcessingConsumer`. **Não** é importado pelo `AppModule`: a API não consome a fila (per phase-03-videos/TD-07)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService.process` | Integration (DB + MinIO + ffmpeg reais, fixture enviado ao bucket de teste): `processing → ready` com metadados e thumbnail no bucket; `audio-only` → `error`/`NO_VIDEO_STREAM`; vídeo fora de `processing` → no-op | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingConsumer` | Unit (mock service): roteamento por `job.name`; `failed` só marca `error` na última tentativa | `src/videos/processing/video-processing.consumer.spec.ts` |
| `VideoProcessingModule` | Unit: compilation sem controllers HTTP | `src/videos/processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.5 (fila e constantes), SI-03.7 (`MediaProbeService`), SI-03.3 (entidade `Video`)

**Acceptance criteria:**

- Processar um vídeo em `processing` cujo objeto é `sample.mp4` termina com `status = 'ready'`, `duration_seconds` ≈ 2.0, `width = 320`, `height = 240`, `format_name` preenchido, `probe_metadata` não nulo, `processed_at` preenchido e `thumbnail_key = '{id}/default.jpg'`
- Depois do processamento, `streamtube-thumbnails-test/{id}/default.jpg` existe com `Content-Type: image/jpeg`
- Processar um vídeo cujo objeto não tem stream de vídeo termina com `status = 'error'` e `processing_error = 'NO_VIDEO_STREAM'`, sem novas tentativas
- Processar um vídeo que já está `ready` não altera a linha
- Um job que falha em todas as 3 tentativas deixa o vídeo com `status = 'error'` e `processing_error` igual a `PROBE_FAILED` ou `THUMBNAIL_FAILED`; falhas intermediárias mantêm `processing`

---

### SI-03.9 — Worker de vídeo: entrypoint standalone, container video-worker e varredura de reconciliação

**Description:** Coloca o consumidor para rodar num container próprio no Compose, sem HTTP, e liga a varredura periódica que re-enfileira vídeos presos em `processing`.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` (`ConfigModule.forRoot` com as mesmas `load`/`validationSchema` do `AppModule`, `TypeOrmModule.forRootAsync` reusando `databaseConfig`, `QueueModule` e `VideoProcessingModule`, sem `AuthModule` nem controllers) e `src/worker/main.ts` (`NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`) (per phase-03-videos/TD-07; convenção herdada `TypeOrmModule.forRootAsync`)
2. Adicionar `VideoProcessingService.reconcileStuck()`: seleciona `status = 'processing' AND updated_at < now() - reconcileStuckAfterMs` e chama `enqueueProcess` para cada vídeo. O consumer roteia `job.name === 'reconcile'` para esse método (per video-processing-job-delivery/TD-01)
3. Criar `src/videos/processing/reconcile.scheduler.ts`, que no `onApplicationBootstrap` do worker chama `queue.upsertJobScheduler('reconcile-stuck-videos', { every: reconcileIntervalMs }, { name: 'reconcile' })` (per video-processing-job-delivery/TD-01; `library-refs.md` → `bullmq` → "Job Schedulers")
4. Criar `nestjs-project/Dockerfile.worker` (`node:25.6.0-slim` + `ffmpeg`) e adicionar o serviço `video-worker` ao `compose.yaml` (build `Dockerfile.worker`, volume do código, `command: npm run start:worker:dev`, `depends_on` `db` healthy + `redis` healthy + `minio` healthy) (per phase-03-videos/TD-07, phase-03-videos/TD-08)
5. Adicionar ao `package.json` os scripts `start:worker` (`node dist/worker/main`) e `start:worker:dev` (`nest start --watch --entryFile worker/main`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService.reconcileStuck` | Integration (DB + Redis reais, prefixo de teste): vídeo em `processing` mais antigo que o limiar é re-enfileirado; vídeo recente ou `ready` não é | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilation; o contexto não registra controllers HTTP | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.8 (consumer e `VideoProcessingModule`)

**Acceptance criteria:**

- `docker compose up -d` sobe o `video-worker` com status `running`, ao lado de `nestjs-api`, `db`, `mailpit`, `minio` e `redis`
- `docker compose exec video-worker ffprobe -version` executa com sucesso, e o worker não abre nenhuma porta HTTP
- Com o worker rodando, um vídeo concluído via `POST /videos/:id/upload/complete` chega a `status = 'ready'` sem nenhuma ação manual
- Um vídeo em `processing` com `updated_at` mais antigo que `VIDEO_RECONCILE_STUCK_AFTER_MS` e sem job na fila ganha um job `process-{id}` no ciclo seguinte da varredura
- Depois do boot do worker, `queue.getJobSchedulers()` lista `reconcile-stuck-videos`

---

### SI-03.10 — Endpoints GET /videos/:publicId, /stream e /download

**Route:** GET /videos/:publicId, GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`
**Authorization:** Owner — não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`, AMB-1)

**Description:** Resolve o vídeo pela URL única e entrega reprodução por streaming e download via URL pré-assinada, com o storage servindo `Range`/`206` e a API fora do caminho dos bytes.

**Technical actions:**

1. Adicionar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) a `src/common/exceptions/domain.exception.ts` (per `### Error Catalog`)
2. Criar `src/videos/dto/video-public-id.param.ts` (`publicId` com `@Matches(/^[0-9A-Za-z]{11}$/)`), `src/videos/dto/video-response.dto.ts` (campos de `GET /videos/:publicId → Response 200`) e `src/videos/dto/playback-url-response.dto.ts` (`url`, `expiresAt`) (per phase-03-videos/TD-10)
3. Implementar no `VideosService`: `findOwnedByPublicId(userId, publicId)` (senão `VideoNotFoundException`), `getVideo(...)` (com `thumbnailUrl` = `presignGet('thumbnails', thumbnail_key, playbackUrlTtlSeconds)` quando houver thumbnail) e `getPlaybackUrl(userId, publicId, kind: 'stream' | 'download')`, que exige `status = 'ready'` (senão `VideoNotReadyException`) e chama `presignGet('videos', source_key, playbackUrlTtlSeconds, kind === 'download' ? { contentDisposition: 'attachment; filename="{original_filename}"' } : {})` (per phase-03-videos/TD-11)
4. Adicionar ao `VideosController` os três `GET` (`200`), com `@ApiParam`, `@ApiResponse(200/400/401/404/409)` e `ApiErrorEnvelope` (per openapi-docs-nestjs/TD-01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getVideo` / `getPlaybackUrl` | Unit (mocks): não-dono → 404; não `ready` → 409; `contentDisposition` só no download | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` | Integration (DB + MinIO reais): URL de stream responde `206` a `Range`; URL de download traz `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (`VideosController`/`VideosService`), SI-03.2 (`presignGet`)

**Acceptance criteria:**

- `GET /videos/:publicId` do dono retorna `200` com `publicId`, `status` e, para vídeo `ready`, `durationSeconds`, `width`, `height` e `thumbnailUrl` não nulos
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com `url` e `expiresAt`; um `GET` nessa `url` com `Range: bytes=0-1023` retorna `206 Partial Content` com 1024 bytes
- `GET /videos/:publicId/download` de um vídeo `ready` retorna `200` com `url`; um `GET` nessa `url` responde com `Content-Disposition: attachment; filename="{original_filename}"`
- `GET /videos/:publicId/stream` de um vídeo em `processing` retorna `409 VIDEO_NOT_READY`
- `GET /videos/:publicId` de outro canal, ou com `publicId` inexistente, retorna `404 VIDEO_NOT_FOUND`
- `GET /videos/:publicId` com `publicId = "abc"` retorna `400`; sem token, retorna `401`

---

### SI-03.11 — Validar fluxo completo de vídeo e documentar a fase (OpenAPI + CLAUDE.md)

**Description:** Prova ponta a ponta, com a infraestrutura real do Compose, o ciclo upload → processamento → streaming/download, e atualiza o contrato OpenAPI e a documentação de IA para refletir o estado real do código.

**Technical actions:**

1. Criar `test/videos.e2e-spec.ts` (supertest + `AppModule` com a configuração global de `main.ts`, buckets de teste e `QUEUE_PREFIX` de teste): registra/confirma/loga um usuário; `POST /videos` com o fixture `sample.mp4`; envia as partes por `PUT` nas URLs pré-assinadas; `POST /videos/:id/upload/complete`; executa o job via `VideoProcessingService.process` (processador invocado direto, sem esperar entrega pela fila; per phase-03-videos/TD-13); verifica `GET /videos/:publicId` (`ready`), `/stream` (`206` em `Range`) e `/download`; e cobre os caminhos negativos de autorização (anônimo `401`, outro usuário `404`)
2. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export`, garantindo os cinco endpoints de vídeo com respostas por status e o envelope de erro (per openapi-docs-nestjs/TD-02), e estender `test/swagger.e2e-spec.ts` para afirmar a presença dos paths `/videos*`
3. Atualizar `nestjs-project/CLAUDE.md`: serviços `minio`, `minio-init`, `redis` e `video-worker`, com os checks de prontidão (`curl` em `/minio/health/live`, `redis-cli ping`) e o script `start:worker`; e seções de storage (buckets, chaves, pré-assinatura), fila/worker (`video-processing`, jobs `process`/`reconcile`) e endpoints de vídeo
4. Atualizar o `CLAUDE.md` raiz: a fila deixa de ser "TBD" (BullMQ + Redis) e entra uma seção de vídeos com o módulo `videos`, os endpoints, o worker e o storage, citando apenas arquivos e comportamentos existentes após SI-03.1–SI-03.10

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo de vídeo completo (`/videos*`) | E2E (supertest + DB/MinIO/Redis/ffmpeg reais): upload multipart → conclusão → processamento → leitura → stream `206` → download; anônimo `401`, outro canal `404` | `test/videos.e2e-spec.ts` |
| `openapi.json` / Swagger | E2E: paths `/videos`, `/videos/{id}/upload/complete`, `/videos/{publicId}`, `/videos/{publicId}/stream` e `/videos/{publicId}/download` presentes | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.6 (conclusão), SI-03.9 (worker e processamento completo), SI-03.10 (leitura/stream/download)

**Acceptance criteria:**

- Um vídeo enviado por multipart com o fixture `sample.mp4` termina com `GET /videos/:publicId` retornando `status: "ready"`, `durationSeconds` ≈ 2.0 e `thumbnailUrl` não nulo
- O `publicId` devolvido por `POST /videos` é diferente para cada vídeo criado e resolve o vídeo correto em `GET /videos/:publicId`
- `openapi.json` versionado contém os cinco endpoints de vídeo com as respostas `4xx` do `### Error Catalog`
- `nestjs-project/CLAUDE.md` e o `CLAUDE.md` raiz descrevem os serviços `minio`, `redis` e `video-worker`, a fila `video-processing` e os endpoints `/videos*`, e todo caminho de arquivo citado existe no repositório
- `docker compose exec nestjs-api npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` passam

---

## Technical Specifications

### Data Model

#### Video (tabela `videos`)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| public_id | varchar(11) | unique, not null — base62 de 11 caracteres sobre `crypto.randomBytes` com amostragem por rejeição (per phase-03-videos/TD-10) |
| title | varchar(100) | not null |
| original_filename | varchar(255) | not null — nome declarado pelo cliente; usado no `Content-Disposition` do download |
| content_type | varchar(100) | not null — declarado no início, validado contra allowlist (per phase-03-videos/TD-05) |
| declared_size_bytes | bigint | not null, `CHECK (declared_size_bytes > 0 AND declared_size_bytes <= 10737418240)` (per phase-03-videos/TD-05) |
| status | enum `video_status` (`uploading`, `processing`, `ready`, `error`) | not null, default `'uploading'` — ciclo de processamento (per phase-03-videos/TD-12 + Revision 2026-10-15) |
| publication_status | enum `video_publication_status` (`draft`) | not null, default `'draft'` — dimensão de publicação separada; `published` é adicionado na Fase 04 (per AMB-2 → Revision da phase-03-videos/TD-12) |
| processing_error | varchar(255) | nullable — último motivo de falha; preenchido só quando `status = 'error'` (per phase-03-videos/TD-12) |
| upload_id | text | nullable — `UploadId` do multipart; limpo (`NULL`) após `CompleteMultipartUpload` ou `AbortMultipartUpload` (per phase-03-videos/TD-03, phase-03-videos/TD-04) |
| source_key | varchar(255) | not null — chave do objeto no bucket de vídeos: `{id}/source` (per phase-03-videos/TD-02) |
| thumbnail_key | varchar(255) | nullable — chave no bucket de thumbnails: `{id}/default.jpg`; preenchida pelo worker (per phase-03-videos/TD-02) |
| duration_seconds | numeric(10,3) | nullable — preenchida pelo worker a partir do `ffprobe` (per AMB-3) |
| width | integer | nullable (per AMB-3) |
| height | integer | nullable (per AMB-3) |
| size_bytes | bigint | nullable — `ContentLength` real conferido via `HeadObject` na conclusão (per phase-03-videos/TD-05, AMB-3) |
| format_name | varchar(100) | nullable — `format.format_name` do `ffprobe` (container/mime; per AMB-3) |
| probe_metadata | jsonb | nullable — saída bruta de `ffprobe -print_format json -show_format -show_streams` (per AMB-3, phase-03-videos/TD-08) |
| processed_at | timestamptz | nullable — instante em que o vídeo chegou a `ready` |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), atualizado a cada escrita (base da varredura de reconciliação) |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.
**Indexes:** unique on `public_id`; btree on `channel_id`; btree composto em `(status, updated_at)` para a varredura de vídeos presos em `processing` (per video-processing-job-delivery/TD-01).
**Notas de mapeamento:** colunas `bigint` são lidas pelo driver `pg` como `string`; a entidade expõe `declared_size_bytes`/`size_bytes` como `string` e a camada de serviço converte para `number` (≤ 10GB cabe em `Number.MAX_SAFE_INTEGER`). A tabela é criada pela migration `<timestamp>-CreateVideos` (versionada, `synchronize: false` — convenção herdada da Fase 01).

#### Object storage (layout — não é tabela)

| Bucket | Acesso | Chave | Conteúdo |
|--------|--------|-------|----------|
| `STORAGE_VIDEOS_BUCKET` (default `streamtube-videos`) | privado; leitura só por URL pré-assinada | `{videoId}/source` | arquivo de vídeo original (multipart) |
| `STORAGE_THUMBNAILS_BUCKET` (default `streamtube-thumbnails`) | privado nesta fase (candidato a leitura pública/CDN em fase futura) | `{videoId}/default.jpg` | thumbnail JPEG gerada pelo worker |

(per phase-03-videos/TD-02.) O bucket de vídeos tem CORS com `ExposeHeaders: ETag` e métodos `PUT`/`GET`, para que o cliente leia o `ETag` de cada parte (per phase-03-videos/TD-03).

### API Contracts

Todos os endpoints exigem `Authorization: Bearer <access_token>` (guard JWT global herdado da Fase 02; nenhum usa `@Public()`). Erros seguem o envelope herdado `{ statusCode, error, message }` (per phase-02-auth/TD-07). Todo endpoint é documentado com decoradores explícitos do `@nestjs/swagger` (`@ApiOperation`, `@ApiResponse` por status, `@ApiBody`, `@ApiParam`) e entra no `openapi.json` exportado (per openapi-docs-nestjs/TD-01, openapi-docs-nestjs/TD-02).

#### POST /videos (SI-03.4)

Pré-cadastra o vídeo como rascunho e inicia o multipart upload direto ao storage (per phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- title: string, required — 1 a 100 caracteres
- fileName: string, required — 1 a 255 caracteres
- contentType: string, required — um de `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- fileSize: integer, required — 1 a 10737418240 (10GB)

**Response 201:**
- id: string (uuid)
- publicId: string (11 caracteres base62)
- status: `"uploading"`
- publicationStatus: `"draft"`
- uploadId: string
- partSize: integer — tamanho de cada parte em bytes (`STORAGE_UPLOAD_PART_SIZE_BYTES`, default 67108864 = 64MiB; a última parte pode ser menor)
- parts: array de `{ partNumber: integer, url: string }` — uma URL `PUT` pré-assinada por parte; quantidade = `ceil(fileSize / partSize)` (nenhuma URL além do tamanho declarado — per phase-03-videos/TD-05)
- expiresAt: string (ISO-8601) — expiração das URLs de parte (`STORAGE_UPLOAD_URL_TTL_SECONDS`)

**Error responses:**
- 400 validation error: body fora das regras acima (inclui `contentType` fora da allowlist e `fileSize` > 10GB)
- 401 Unauthorized: token ausente ou inválido

---

#### POST /videos/:id/upload/complete (SI-03.6)

Conclui o multipart, verifica o tamanho real e enfileira o processamento (per phase-03-videos/TD-04, phase-03-videos/TD-05, video-processing-job-delivery/TD-01).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Path parameters:**
- id: string (uuid) — `id` devolvido por `POST /videos`

**Request body:**
- parts: array, required — 1 a 10000 itens de `{ partNumber: integer ≥ 1, etag: string não vazia }`

**Response 200:**
- id: string (uuid)
- publicId: string
- status: `"processing"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 INVALID_VIDEO_STATE: vídeo não está em `uploading`
- 422 UPLOAD_COMPLETION_FAILED: o storage rejeitou o `CompleteMultipartUpload` (parte ausente ou `ETag` inválido); o vídeo permanece em `uploading` e o cliente pode tentar de novo
- 422 UPLOAD_SIZE_MISMATCH: `ContentLength` real (via `HeadObject`) difere do `fileSize` declarado; o objeto é apagado e o vídeo vai para `error`
- 400 validation error: body fora das regras acima ou `id` não é uuid
- 401 Unauthorized: token ausente ou inválido

---

#### GET /videos/:publicId (SI-03.10)

Lê o vídeo pela URL única; permite acompanhar o ciclo de status (per phase-03-videos/TD-10, phase-03-videos/TD-12).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- publicId: string — 11 caracteres `[0-9A-Za-z]`

**Response 200:**
- id: string (uuid)
- publicId: string
- title: string
- status: `"uploading" | "processing" | "ready" | "error"`
- publicationStatus: `"draft"`
- processingError: string | null
- durationSeconds: number | null
- width: integer | null
- height: integer | null
- sizeBytes: integer | null
- formatName: string | null
- thumbnailUrl: string | null — GET pré-assinado da thumbnail (null enquanto `thumbnail_key` for null)
- createdAt: string (ISO-8601)
- processedAt: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de outro canal
- 400 validation error: `publicId` fora do formato
- 401 Unauthorized: token ausente ou inválido

---

#### GET /videos/:publicId/stream (SI-03.10)

Devolve uma URL GET pré-assinada de vida curta; o storage serve `Range`/`206 Partial Content` nativamente (per phase-03-videos/TD-11).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- publicId: string — 11 caracteres `[0-9A-Za-z]`

**Response 200:**
- url: string — GET pré-assinado do objeto `{videoId}/source` (`STORAGE_PLAYBACK_URL_TTL_SECONDS`)
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de outro canal
- 409 VIDEO_NOT_READY: `status` diferente de `ready`
- 400 validation error: `publicId` fora do formato
- 401 Unauthorized: token ausente ou inválido

---

#### GET /videos/:publicId/download (SI-03.10)

Mesmo mecanismo do stream, com `response-content-disposition=attachment` assinado na URL (per phase-03-videos/TD-11).

**Request headers:**
- Authorization: Bearer <access_token>

**Path parameters:**
- publicId: string — 11 caracteres `[0-9A-Za-z]`

**Response 200:**
- url: string — GET pré-assinado com `ResponseContentDisposition: attachment; filename="{original_filename}"`
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou de outro canal
- 409 VIDEO_NOT_READY: `status` diferente de `ready`
- 400 validation error: `publicId` fora do formato
- 401 Unauthorized: token ausente ou inválido

---

#### Validation Rules — vídeos

- `title`: required, string, trim, 1–100 caracteres
- `fileName`: required, string, 1–255 caracteres
- `contentType`: required, `IsIn(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'])` — a allowlist é reconferida pelo `ffprobe` no worker: arquivo sem stream de vídeo termina em `error` (per phase-03-videos/TD-05)
- `fileSize`: required, inteiro, `Min(1)`, `Max(10737418240)`
- `parts`: required, array 1–10000, `ValidateNested` de `{ partNumber: IsInt Min(1) Max(10000), etag: IsString IsNotEmpty }`
- `:id`: `ParseUUIDPipe`
- `:publicId`: `Matches(/^[0-9A-Za-z]{11}$/)`

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (outro canal) | Owner |
|----------|-----------|-----------------------------|-------|
| POST /videos | ✗ 401 | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:id/upload/complete | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId/stream | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |
| GET /videos/:publicId/download | ✗ 401 | ✗ 404 VIDEO_NOT_FOUND | ✓ |

"Owner" = o canal do usuário autenticado (`channels.user_id = sub` do JWT) é o `channel_id` do vídeo. Nesta fase, leitura, stream e download são restritos ao dono; acesso anônimo/público chega com publicação e visibilidade na Fase 04 (per AMB-1). Não-dono recebe 404 (não 403) para não revelar a existência do vídeo. A autorização fica na API; a URL pré-assinada emitida é bearer até expirar — revogação limitada pelo TTL (per phase-03-videos/TD-11).

### Error Catalog

Envelope herdado da Fase 02: `{ statusCode, error, message }` via `DomainExceptionFilter` (per phase-02-auth/TD-07). Novas exceções estendem `DomainException(errorCode, httpStatus, message)` em `src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, ou pertence a outro canal |
| INVALID_VIDEO_STATE | 409 | Conclusão de upload com o vídeo fora de `uploading` |
| UPLOAD_COMPLETION_FAILED | 422 | Storage rejeita `CompleteMultipartUpload` (parte ausente/`ETag` inválido); vídeo segue em `uploading` |
| UPLOAD_SIZE_MISMATCH | 422 | `HeadObject.ContentLength` ≠ `declared_size_bytes`; objeto apagado e vídeo marcado `error` |
| VIDEO_NOT_READY | 409 | Stream ou download com `status` diferente de `ready` |

**Motivos de falha do processamento** (gravados em `videos.processing_error`, não expostos como HTTP de erro — aparecem em `GET /videos/:publicId → processingError`):

| processing_error | Trigger |
|------------------|---------|
| UPLOAD_SIZE_MISMATCH | Gravado pela API na conclusão (ver acima) |
| NO_VIDEO_STREAM | `ffprobe` não encontra stream de vídeo — content-type declarado era falso; falha não retentável (per phase-03-videos/TD-05) |
| PROBE_FAILED | `ffprobe` falhou em todas as tentativas do job |
| THUMBNAIL_FAILED | Extração do frame (`ffmpeg -frames:v 1`) ou upload da thumbnail falhou em todas as tentativas |

### Events/Messages

Fila BullMQ `video-processing` sobre Redis, registrada via `@nestjs/bullmq` (per phase-03-videos/TD-06). Produtores rodam na API; o consumidor roda só no container `video-worker` (per phase-03-videos/TD-07).

#### video-processing → `process`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingQueue` (serviço produtor do módulo de fila), chamado por `VideosService.completeUpload` **depois** do commit que muda o vídeo para `processing`, e pela varredura `reconcile` (per video-processing-job-delivery/TD-01)
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing')` estendendo `WorkerHost`, rota por `job.name`) no container `video-worker` (per phase-03-videos/TD-07)
**Trigger:** vídeo transita `uploading → processing` na conclusão do upload, ou a varredura encontra vídeo preso em `processing`
**Job options:** `jobId: 'process-{videoId}'` (determinístico; sem `:`, não numérico — deduplica re-enfileiramentos), `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: { age: 604800 }` (per phase-03-videos/TD-06, library-refs → bullmq)
**Processamento:** gera GET pré-assinado do objeto fonte e passa a URL ao `ffprobe` (metadados) e ao `ffmpeg -ss … -frames:v 1` (thumbnail), lendo por `Range` sem disco de rascunho (per phase-03-videos/TD-08, phase-03-videos/TD-09); grava a thumbnail em `{videoId}/default.jpg`; atualiza `duration_seconds`, `width`, `height`, `format_name`, `probe_metadata`, `thumbnail_key`, `status = 'ready'`, `processed_at`.
**Idempotência:** se o vídeo não estiver em `processing` quando o job começa, o job termina sem efeito.
**Falha:** `NO_VIDEO_STREAM` lança `UnrecoverableError` (sem retentativa). Demais falhas retentam; quando o job esgota as tentativas, o vídeo vai para `status = 'error'` com `processing_error` (per phase-03-videos/TD-12).
**Delivery semantics:** at-least-once (per video-processing-job-delivery/TD-01)

#### video-processing → `reconcile`

**Payload:**

```json
{}
```

**Producer:** Job Scheduler `reconcile-stuck-videos` registrado via `queue.upsertJobScheduler('reconcile-stuck-videos', { every: VIDEO_RECONCILE_INTERVAL_MS }, { name: 'reconcile' })` no boot do worker (per video-processing-job-delivery/TD-01)
**Consumer:** `VideoProcessingConsumer` (mesmo processor, `job.name === 'reconcile'`)
**Trigger:** periódico (`VIDEO_RECONCILE_INTERVAL_MS`, default 300000 = 5 min)
**Processamento:** seleciona vídeos com `status = 'processing'` e `updated_at < now() - VIDEO_RECONCILE_STUCK_AFTER_MS` (default 900000 = 15 min) e re-enfileira `process` com o mesmo `jobId: 'process-{videoId}'` — o BullMQ ignora o `add` se o job ainda existe na fila.
**Delivery semantics:** best-effort por ciclo; o próximo ciclo cobre falhas do anterior (per video-processing-job-delivery/TD-01)

---

## Dependency Map

```
SI-03.1 (root — MinIO, Redis, config)
├── SI-03.2 — depends on SI-03.1 (storage precisa do MinIO, buckets e storageConfig)
│   ├── SI-03.4 — depends on SI-03.2 + SI-03.3 (multipart/pré-assinatura + entidade Video)
│   │   ├── SI-03.6 — depends on SI-03.4 + SI-03.5 (vídeo em uploading + produtor da fila)
│   │   │   └── SI-03.11 — depends on SI-03.6 + SI-03.9 + SI-03.10 (fluxo completo + docs)
│   │   └── SI-03.10 — depends on SI-03.4 + SI-03.2 (controller/serviço de vídeos + presignGet)
│   │       └── SI-03.11 (ver acima)
│   └── SI-03.7 — depends on SI-03.2 (URL pré-assinada para leitura por Range no ffprobe)
│       └── SI-03.8 — depends on SI-03.5 + SI-03.7 + SI-03.3 (fila + MediaProbeService + entidade)
│           └── SI-03.9 — depends on SI-03.8 (worker hospeda o consumer + varredura)
│               └── SI-03.11 (ver acima)
└── SI-03.5 — depends on SI-03.1 + SI-03.3 (Redis/queueConfig + VideosModule)
    ├── SI-03.6 (ver acima)
    └── SI-03.8 (ver acima)
SI-03.3 (root — entidade Video, migration, public_id; independente da infra nova)
├── SI-03.4 (ver acima)
├── SI-03.5 (ver acima)
└── SI-03.8 (ver acima)
```

Ordem de execução linear compatível: SI-03.1 → SI-03.3 → SI-03.2 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11.

---

## Deliverables

- [ ] SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila
- [ ] SI-03.2 — Implementar StorageModule (cliente S3 + URLs pré-assinadas)
- [ ] SI-03.3 — Criar entidade Video, migration CreateVideos e gerador de public_id
- [ ] SI-03.4 — Endpoint POST /videos (pré-cadastro em rascunho + início do multipart)
- [ ] SI-03.5 — Implementar módulo de fila e produtor VideoProcessingQueue
- [ ] SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + verificação + enfileiramento)
- [ ] SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg via child_process)
- [ ] SI-03.8 — Implementar processamento do vídeo (VideoProcessingService + consumer)
- [ ] SI-03.9 — Worker de vídeo: entrypoint standalone, container video-worker e varredura de reconciliação
- [ ] SI-03.10 — Endpoints GET /videos/:publicId, /stream e /download
- [ ] SI-03.11 — Validar fluxo completo de vídeo e documentar a fase (OpenAPI + CLAUDE.md)

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
