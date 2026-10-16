---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como rascunho no canal do usuário autenticado e inicia um multipart upload direto ao object storage (MinIO). A resposta traz o `id`, o `publicId` (URL única base62 de 11 caracteres), `status: "uploading"`, `publicationStatus: "draft"`, o `uploadId` e uma URL `PUT` pré-assinada por parte (`ceil(fileSize / partSize)` partes), para que o cliente envie os bytes sem passar pela API. O body é validado (`title`, `fileName`, `contentType` na allowlist de vídeo, `fileSize` de 1 a 10GB). O endpoint exige JWT.

## Test Scenarios

### 1. Pré-cadastro do vídeo e início do multipart

**Setup:** `beforeEach` limpa `videos`/`channels`/`users` no banco de teste; o app é criado com `Test.createTestingModule({ imports: [AppModule] }).compile()` + a configuração global de `main.ts` (ValidationPipe, filtros), apontando para os buckets `streamtube-videos-test`/`streamtube-thumbnails-test` e um `QUEUE_PREFIX` de teste. Um usuário confirmado é criado e logado para obter o `access_token`.

#### 1.1. cria-video-em-rascunho-com-urls-de-parte

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ "title": "Meu vídeo", "fileName": "meu-video.mp4", "contentType": "video/mp4", "fileSize": 200000000 }`
    - expect: status `201`
    - expect: body com `id` (uuid), `publicId` casando `/^[0-9A-Za-z]{11}$/`, `status: "uploading"`, `publicationStatus: "draft"`, `uploadId` não vazio, `partSize` inteiro e `expiresAt` ISO-8601
    - expect: `parts.length` igual a `Math.ceil(200000000 / partSize)` e `parts[i].partNumber` igual a `i + 1`
  2. Consultar a tabela `videos` pelo `id` retornado
    - expect: linha com `status = 'uploading'`, `publication_status = 'draft'`, `upload_id` igual ao `uploadId`, `source_key = '{id}/source'`, `declared_size_bytes = 200000000`
    - expect: `channel_id` igual ao id do canal do usuário logado

#### 1.2. urls-de-parte-aceitam-put-direto-no-storage

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos com token válido e `fileSize` igual ao tamanho de um buffer de 6MiB (`contentType: "video/mp4"`)
    - expect: status `201` com `parts` não vazio
  2. Fazer `PUT` HTTP direto em `parts[0].url` com o primeiro bloco de `partSize` bytes do buffer (sem header `Authorization`)
    - expect: status `200`
    - expect: header `ETag` presente e não vazio

### 2. Validação e autenticação

**Setup:** mesmo setup do grupo 1.

#### 2.1. rejeita-content-type-fora-da-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos com token válido e body com `contentType: "video/avi"` (demais campos válidos)
    - expect: status `400`
    - expect: nenhuma linha nova em `videos`

#### 2.2. rejeita-arquivo-acima-de-10gb

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos com token válido e body com `fileSize: 10737418241` (demais campos válidos)
    - expect: status `400`
    - expect: nenhuma linha nova em `videos`

#### 2.3. exige-autenticacao

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos sem header `Authorization` e com body válido
    - expect: status `401`
    - expect: nenhuma linha nova em `videos`
