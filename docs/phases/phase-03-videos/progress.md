# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

### SI-03.1 — Infra: MinIO, Redis e configuração de storage/fila
- **Status:** completed
- **Tests:** 9 passing (`src/config/env.validation.integration-spec.ts`)
- **Observations:**
  - **Imagem do MinIO:** `minio/minio` e `minio/mc` não estão mais publicadas no Docker Hub (repositório inexistente) nem no Quay (`unauthorized`). Usado `bitnamilegacy/minio` + `bitnamilegacy/minio-client` (mesmo servidor MinIO, `2025-05-24`); a decisão "MinIO local" da phase-03-videos/TD-02 segue válida, mudou só a origem da imagem. Imagem legacy não recebe atualizações — revisar antes de produção.
  - **CORS:** o MinIO não suporta a API `BucketCORS` (confirmado via Context7, `minio-limits.md`); CORS fica ligado em todos os buckets e só as origens são configuráveis (`MINIO_API_CORS_ALLOW_ORIGIN`). A action 1 ("aplica nos buckets de vídeo um CORS") foi atendida por essa via. Verificado: `Access-Control-Expose-Headers` da resposta real contém `Etag` (o header vem na resposta, não no preflight, por definição do CORS). Em S3 real será preciso `PutBucketCors` com `ExposeHeaders: ETag`.
  - Verificado manualmente: `minio`/`redis` healthy, `minio-init` exit 0, `mc ls` lista os 4 buckets, `redis-cli ping` → `PONG`.
  - `compose.override.yaml` (local, não versionado) roda o `nestjs-api` como `1001:1001`; o `video-worker` (SI-03.9) precisará do mesmo override nesta máquina.

### SI-03.2 — Implementar StorageModule (cliente S3 + URLs pré-assinadas)
- **Status:** completed
- **Tests:** 7 passing (`src/storage/storage.module.spec.ts`, `src/storage/storage.service.integration-spec.ts`)
- **Observations:**
  - `StorageService.headObject` converte só o `404` do storage em `null` (ausência é resultado válido de domínio); qualquer outro erro propaga.
  - **Follow-up fora de escopo:** as URLs pré-assinadas são assinadas com o host `STORAGE_ENDPOINT` (`http://minio:9000`), que resolve dentro da rede do Compose mas não num navegador no host. Quando o frontend consumir upload/stream (Fases 04–05), será preciso um endpoint público de storage (ex.: `STORAGE_PUBLIC_ENDPOINT` usado só para assinar) — o SigV4 inclui o host na assinatura, então não dá para reescrever a URL depois.

### SI-03.3 — Criar entidade Video, migration CreateVideos e gerador de public_id
- **Status:** completed
- **Tests:** 12 passing (`src/database/migrations.integration-spec.ts`, `src/videos/entities/video.entity.integration-spec.ts`, `src/videos/public-id.util.spec.ts`, `src/videos/videos.module.spec.ts`)
- **Observations:**
  - Migration `1792171312702-CreateVideos` gerada via `migration:generate` a partir da entidade (entidade e schema coincidem por construção — relevante porque as suítes de entidade usam `synchronize: true` no banco compartilhado); enums com nome explícito (`video_status`, `video_publication_status`), `CHECK` e índices nomeados.
  - **Exceção justificada à rule `nestjs-entities.md` ("Always define both sides of a relationship"):** `@ManyToOne(() => Channel)` mantida unidirecional, como o plano define. Adicionar `@OneToMany(() => Video)` em `Channel` quebraria toda suíte que monta `DataSource` com listas explícitas de entidades sem `Video` ("Entity metadata for Channel#videos was not found").
  - `duration_seconds` (`numeric`) usa transformer para expor `number`; colunas `bigint` seguem como `string` na entidade, conforme o Data Model.
  - **Ambiente pré-existente corrigido:** o banco de dev tinha `users`/`channels`/tokens criados por `synchronize` mas a tabela `migrations` vazia, então `migration:run` falhava com `relation "channels" already exists` (não causado por este SI). O `migrations.integration-spec.ts` agora também dropa os tipos enum antes de reaplicar (o `DROP TABLE ... CASCADE` não remove tipos) e, ao rodar, deixou o banco com as 3 migrations registradas; `migration:run` → "No migrations are pending".

### SI-03.4 — Endpoint POST /videos (pré-cadastro em rascunho + início do multipart)
- **Status:** completed
- **Tests:** 19 passing — 14 inline (`src/videos/videos.service.spec.ts`, `src/videos/videos.service.integration-spec.ts`, `src/videos/videos.module.spec.ts`, `src/channels/channels.service.integration-spec.ts`) + 5 E2E (`test/videos-create.e2e-spec.ts`, gerado de `specs/videos-create.plan.md`)
- **Observations:**
  - **Desvio do plano (action 2) por rule do projeto:** o plano pedia `@ApiProperty` nos dois DTOs; a rule `nestjs-dtos.md` proíbe `@ApiProperty` em DTO de request (o plugin do Swagger infere de `class-validator`; anotar à mão gera drift). `CreateVideoDto` ficou só com `class-validator` + JSDoc; `CreateVideoResponseDto` (response) mantém `@ApiProperty`.
  - Controller segue a rule `nestjs-controllers.md`: `@ApiBearerAuth('access-token')` no método e `@HttpCode(HttpStatus.CREATED)` explícito.
  - Usuário sem canal lança `Error` genérico (invariante da Fase 02 quebrada — todo usuário ganha canal no cadastro); não há errorCode no `### Error Catalog` para isso, então não foi inventado um.
  - Criado `test/support/e2e-app.ts` (bootstrap com a config global de `main.ts`, buckets de teste, `QUEUE_PREFIX` de teste e `registerConfirmAndLogin`), reusado pelos E2E de vídeo seguintes. O `test/auth.e2e-spec.ts` mantém sua cópia local do setup (refatorar está fora do escopo).
  - Aviso `DeprecationWarning: Calling client.query() when the client is already executing a query` (pg) aparece nas suítes de integração; vem do TypeORM sobre `pg` e não afeta resultados — follow-up para quando o `pg@9` for adotado.

### SI-03.5 — Implementar módulo de fila e produtor VideoProcessingQueue
- **Status:** completed
- **Tests:** 7 passing (`src/queue/queue.module.spec.ts`, `src/videos/processing/video-processing.queue.integration-spec.ts`, `src/videos/videos.module.spec.ts`, `src/videos/videos.service.integration-spec.ts`); regressão `test/videos-create.e2e-spec.ts` 5 passing; sem open handles
- **Observations:**
  - **Correção de versão (fix-loop, 2 tentativas):** (1) `@nestjs/bullmq` 12.x / `@nestjs/bull-shared` 12.x são **ESM-only**; o backend é CommonJS e o Jest não transforma `node_modules` → `SyntaxError: Unexpected token 'export'`. Fixado `@nestjs/bullmq@^11.0.5` (última linha CJS; peers já aceitam `bullmq ^6` e `@nestjs/core ^11`). (2) No BullMQ 6 o `ioredis` virou **peer opcional** e não vem instalado → `BullMQ could not load the optional 'ioredis' package` + crash no `onApplicationShutdown`. Adicionado `ioredis@^5.11.1` (CJS). `library-refs.md` corrigido com as duas notas. A verificação de formato de módulo (ESM vs CJS) faltou no `/plan-resolve` — vale incluí-la nas próximas fixações de lib.
  - `VideosModule` agora importa `QueueModule` e exporta `VideoProcessingQueue`; os testes que compilam o `VideosModule` (`videos.module.spec.ts`, `videos.service.integration-spec.ts`) passaram a carregar `queueConfig` e o prefixo de teste.
  - Criado `src/test/queue.ts` (`useTestQueuePrefix()` → `streamtube-test`, `openVideoProcessingQueue(prefix)`); E2E usam `streamtube-e2e` via `test/support/e2e-app.ts`. Nenhum job de teste cai no prefixo `streamtube` do worker real (coberto por teste).
  - `QueueModule` importa `VIDEO_PROCESSING_QUEUE` de `src/videos/processing/video-processing.constants.ts` (o plano registra a fila no módulo de infra).

### SI-03.6 — Endpoint POST /videos/:id/upload/complete (conclusão + verificação + enfileiramento)
- **Status:** completed
- **Tests:** 27 passing — 21 inline (`src/videos/videos.service.spec.ts`, `src/videos/videos.service.integration-spec.ts`) + 6 E2E (`test/videos-upload-complete.e2e-spec.ts`, gerado de `specs/videos-upload-complete.plan.md`); regressão `test/videos-create.e2e-spec.ts` 5 passing
- **Observations:**
  - **Exceção justificada à rule `nestjs-services.md` ("catch must end with throw" no request lifecycle):** a falha de `enqueueProcess` depois do commit é logada e **não** relançada, por design da video-processing-job-delivery/TD-01 — a linha em `processing` é o registro durável e a varredura (SI-03.9) re-enfileira; relançar devolveria 500 para um upload concluído e o retry do cliente levaria 409. Comentado no código e coberto por teste unitário.
  - Transição `uploading → processing` via `UPDATE ... WHERE status = 'uploading'` condicional: conclusões concorrentes resultam em `409 INVALID_VIDEO_STATE` e um único enqueue.
  - Rejeições do storage mapeadas para `422 UPLOAD_COMPLETION_FAILED`: `InvalidPart`, `InvalidPartOrder`, `NoSuchUpload` e `EntityTooSmall` (este último — parte intermediária < 5MiB — não estava listado no plano, mas é a mesma classe "lista de partes inválida do cliente"). Demais erros do storage propagam (500).
  - Ownership centralizado em `VideosService.findOwnedById` (canal do usuário via `ChannelsService.findByUserId`), reaproveitável no SI-03.10.
  - O E2E sobe o app com `STORAGE_UPLOAD_PART_SIZE_BYTES=5242880` (mínimo do S3) para que um payload de 6MiB gere 2 partes e o cenário "parte faltando" seja exercitável sem enviar 64MiB+.

### SI-03.7 — Implementar MediaProbeService (ffprobe/ffmpeg via child_process)
- **Status:** completed
- **Tests:** 11 passing (`src/media/media-probe.service.spec.ts`, `src/media/media-probe.service.integration-spec.ts`, `src/media/media.module.spec.ts`)
- **Observations:**
  - `Dockerfile.dev` agora instala `ffmpeg` (Debian 12 → FFmpeg 5.1.9, com `libx264`/`aac`); imagem do `nestjs-api` reconstruída (`docker compose build nestjs-api`). Quem já tem o ambiente precisa rebuildar a imagem.
  - Fixtures gerados com o próprio ffmpeg e versionados: `test/fixtures/sample.mp4` (17KB, 2s, 320×240, H.264 + AAC, `-movflags +faststart` → `moov` no início, o que favorece leitura por `Range`) e `test/fixtures/audio-only.m4a` (9KB, sem stream de vídeo).
  - `run()` faz `spawn` com timeout (`SIGKILL` ao estourar) e embute o stderr do binário na `MediaCommandError`; `NoVideoStreamError` é erro de domínio do worker (não `DomainException` HTTP). Probe e thumbnail via URL GET pré-assinada do MinIO verificados em teste (phase-03-videos/TD-09).

### SI-03.8 — Implementar processamento do vídeo (VideoProcessingService + consumer)
- **Status:** completed
- **Tests:** 13 passing (`src/videos/processing/video-processing.service.integration-spec.ts`, `src/videos/processing/video-processing.consumer.spec.ts`, `src/videos/processing/video-processing.module.spec.ts`)
- **Observations:**
  - Motivo da falha por estágio: o serviço embrulha falhas de probe/thumbnail em `ProcessingStageError(reason)`; o consumer, no `@OnWorkerEvent('failed')`, só grava `error` quando `attemptsMade >= opts.attempts`, usando o `reason` (falhas sem estágio — ex.: presign — caem em `PROBE_FAILED`). `NO_VIDEO_STREAM` grava `error` na hora e lança `UnrecoverableError` (sem retentativa).
  - Escritas condicionais (`WHERE status = 'processing'`) tanto no `ready` quanto no `markFailed`: o job é idempotente sob reentrega at-least-once e uma falha tardia nunca sobrescreve um vídeo já `ready`.
  - O handler `failed` faz catch-and-log sem relançar — contexto de background/event handler, permitido pela rule `nestjs-services.md`.
  - `VideoProcessingModule` também provê `VideoProcessingQueue` (necessário à varredura do SI-03.9) em vez de importar `VideosModule`, que traria o controller HTTP para o worker; e não é importado pelo `AppModule` (a API só produz jobs — phase-03-videos/TD-07).
  - A integração do serviço monta só storage/media/TypeORM (sem worker BullMQ ligado) e invoca `process` direto, conforme phase-03-videos/TD-13.

### SI-03.9 — Worker de vídeo: entrypoint standalone, container video-worker e varredura de reconciliação
- **Status:** completed
- **Tests:** 21 passing (`src/videos/processing/*` + `src/worker/worker.module.spec.ts`); smoke manual com o container `video-worker` real: job enfileirado no prefixo `streamtube` → vídeo `ready` (2.000s, 320×240, thumbnail JPEG no bucket), dados do smoke removidos ao final
- **Observations:**
  - **Desvio do plano (action 5):** o `start:worker:dev` previsto (`nest start --watch --entryFile worker/main`) compilaria no mesmo `dist/` do `start:dev` da API, e com `deleteOutDir: true` os dois watchers apagariam a saída um do outro. Criado `tsconfig.worker.json` (`outDir: ./dist-worker`) e o script virou `nest start --watch --path tsconfig.worker.json --entryFile worker/main`; `dist-worker` no `.gitignore`. `start:worker` (prod) segue `node dist/worker/main` após o `npm run build` normal.
  - **Bug encontrado ao subir o worker real:** `Entity metadata for Video#channel was not found` — o `autoLoadEntities` só carrega entidades de algum `forFeature`, e no worker só `Video` estava registrada. `WorkerModule` agora registra `TypeOrmModule.forFeature([Channel, User])` para fechar o grafo `Video → Channel ↔ User`. Os testes do SI-03.8 não pegaram porque usam listas explícitas de entidades; o novo `worker.module.spec.ts` sobe o `WorkerModule` real (config + `autoLoadEntities` contra o banco) e cobre isso.
  - **Erros de tipo de SIs anteriores corrigidos aqui:** o `ts-jest` roda com `isolatedModules: true` (só transpila, sem type-check), então `tsc --noEmit` revelou: `probe_metadata`/`ProbeResult.raw` como `Record<string, unknown>` rejeitado pelo `update` do TypeORM (→ `Record<string, any>`), e `fetch({ body: Buffer })` em 3 testes incompatível com os tipos do Node 25 (→ `Uint8Array.from(...)`). `npx tsc --noEmit` agora sai com 0.
  - Refactor para não duplicar config entre os dois entrypoints: `src/config/config-module.options.ts` (`CONFIG_MODULE_OPTIONS`) e `src/database/typeorm-options.factory.ts` (`buildTypeOrmOptions`), usados por `AppModule` e `WorkerModule` (convenção herdada: parâmetros de conexão em uma única fonte).
  - `compose.override.yaml` (local, não versionado) ganhou o mesmo override de usuário `1001:1001` para o `video-worker`. Verificado no container: `ffprobe` disponível, nenhuma porta publicada (único socket em escuta é o DNS interno do Docker, `127.0.0.11`), scheduler `reconcile-stuck-videos` registrado no Redis.

### SI-03.10 — Endpoints GET /videos/:publicId, /stream e /download
- **Status:** completed
- **Tests:** 39 passing — 33 inline (`src/videos/videos.service.spec.ts`, `src/videos/videos.service.integration-spec.ts`) + 6 E2E (`test/videos-read.e2e-spec.ts`, gerado de `specs/videos-read.plan.md`); regressão `videos-create` + `videos-upload-complete` E2E 11 passing; `npx tsc --noEmit` exit 0
- **Observations:**
  - **Hardening fora do plano:** o `original_filename` vem do cliente e é assinado no `Content-Disposition` do download; `"`, `\`, CR e LF são trocados por `_` antes de montar `attachment; filename="..."` (evita quebrar o parâmetro/injetar header). Coberto por teste unitário.
  - Ownership unificado em `findOwned(userId, { id } | { public_id })` — usado por conclusão, leitura, stream e download; não-dono recebe 404 (não revela existência), conforme a Authorization Matrix.
  - Stream e download exigem `status = 'ready'` (`409 VIDEO_NOT_READY` em `uploading`/`processing`/`error`); `thumbnailUrl` é `null` até o worker gravar a thumbnail.
  - O E2E de leitura semeia o vídeo `ready` direto no banco + fixture real no bucket, isolando a leitura do processamento; o fluxo ponta a ponta upload → processamento → leitura fica no SI-03.11.

### SI-03.11 — Validar fluxo completo de vídeo e documentar a fase (OpenAPI + CLAUDE.md)
- **Status:** completed
- **Tests:** 10 passing (`test/videos.e2e-spec.ts` — upload multipart → conclusão → processamento com ffmpeg real → leitura/stream 206/download byte a byte, `publicId` distinto por vídeo, privacidade por canal; `test/swagger.e2e-spec.ts` — paths `/videos*` e status de erro)
- **Observations:**
  - `openapi.json` regenerado (`npm run openapi:export`): os 5 endpoints de vídeo com as respostas `4xx` do Error Catalog e os DTOs de resposta completos.
  - **Follow-up fora de escopo (pré-existente desde a Fase 02):** no `openapi.json` exportado, os schemas dos DTOs de **request** saem sem propriedades (`RegisterDto`, `LoginDto`, `ResetPasswordDto` já estavam assim; agora também `CreateVideoDto`/`CompleteUploadDto`). O `openapi:export` roda via `ts-node`, sem o plugin do `@nestjs/swagger` que a rule `nestjs-dtos.md` pressupõe. Corrigir o pipeline de export (ex.: gerar o metadata do plugin) é tarefa separada.
  - `CLAUDE.md` raiz: fila deixa de ser "TBD" (BullMQ + Redis), nova seção "Videos (Phase 03)"; corrigidas duas afirmações já desatualizadas — módulo `comments` inexistente e `next-frontend/` "not yet initialized" (existe desde a Fase 02).
  - `nestjs-project/CLAUDE.md`: novos serviços com checks de prontidão, `video-worker` como parte do ambiente, rebuild das imagens, scripts, `dist-worker/`, e seção "Videos module" (endpoints, componentes, status, isolamento de testes). Todos os caminhos citados nos dois arquivos foram conferidos no disco.

## Final verification

Rodada após o SI-03.11 (Deliverables do plano), dentro do container `nestjs-api`:

| Check | Resultado |
|-------|-----------|
| `npm test -- --runInBand` | PASS — 39 suítes, 234 testes |
| `npm run test:e2e` | PASS — 7 suítes, 73 testes |
| `npx tsc --noEmit` | PASS — exit 0 |
| `npm run lint` | PASS — 0 erros, 1 warning (`no-unsafe-argument`, pré-existente em `src/auth/auth.service.integration-spec.ts`) |
| `npm run build` | PASS |

Correções feitas durante a verificação final (fix-loop, 1 tentativa):

- **E2E em paralelo:** `test:e2e` não tinha `--runInBand` (o `nestjs-project/CLAUDE.md` já afirmava que tinha). Com 5 suítes E2E batendo no mesmo banco, o paralelismo gerava violações de FK/500. Script corrigido para `jest --config ./test/jest-e2e.json --runInBand`.
- **Lint dos arquivos da fase:** corpos do supertest tipados com os DTOs reais via `bodyOf<T>()` (`test/support/e2e-app.ts`), schema Joi tipado (`Joi.object<Record<string, unknown>>`), mocks sem `async` ocioso. O `lint --fix` havia removido um `as any` em `e2e-app.ts` e quebrado o `tsc` (acesso a `mailService` privado) — trocado por `app.get(MailService)`.
- **Dívida de lint pré-existente (Fase 02):** 142 erros em 9 arquivos de teste não tocados pela fase faziam `npm run lint` falhar desde antes da Fase 03. Por decisão do usuário, corrigidos em commit separado (`chore(lint)`), só tipagem, com a suíte inteira reexecutada depois.

## Follow-ups (fora do escopo da fase)

- **Endpoint público de storage para o navegador** (SI-03.2): URLs pré-assinadas usam o host `minio:9000`; o frontend (Fases 04–05) vai precisar de um endpoint público só para assinar.
- **Imagem do MinIO** (SI-03.1): `bitnamilegacy/minio` não recebe atualizações — revisar antes de produção; em S3 real configurar `PutBucketCors` com `ExposeHeaders: ETag`.
- **`openapi.json` sem propriedades nos DTOs de request** (SI-03.11, pré-existente desde a Fase 02): o `openapi:export` via `ts-node` não roda o plugin do `@nestjs/swagger`.
- **Aviso de deprecação do `pg`** (`client.query()` concorrente, removido no `pg@9`) emitido pelo TypeORM nas suítes de integração.
- **Coletor de rascunhos abandonados** (phase-03-videos/TD-04): uploads iniciados e nunca concluídos ficam em `uploading`; adiado por decisão da TD.
- **Fixação de libs no `/plan-resolve`:** incluir verificação de formato de módulo (ESM vs CJS) e de peers opcionais — as duas falhas do SI-03.5 vieram daí.

