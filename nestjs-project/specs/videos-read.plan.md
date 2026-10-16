---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-read.e2e-spec.ts
---

# GET /videos/:publicId, /stream e /download — Test Plan

## Application Overview

Três endpoints resolvem um vídeo pela URL única (`publicId`, base62 de 11 caracteres). `GET /videos/:publicId` devolve os dados e o ciclo de status do vídeo, incluindo os metadados do processamento e uma `thumbnailUrl` pré-assinada quando há thumbnail. `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` devolvem `{ url, expiresAt }` com uma URL GET pré-assinada de vida curta. O storage serve `Range`/`206 Partial Content` nativamente, e no download a URL carrega `Content-Disposition: attachment`. Stream e download exigem `status = 'ready'` (senão `409 VIDEO_NOT_READY`). Nesta fase só o dono do canal lê o vídeo: os outros recebem `404 VIDEO_NOT_FOUND` e anônimos recebem `401`.

## Test Scenarios

### 1. Leitura, streaming e download de vídeo pronto

**Setup:** `beforeEach` limpa `videos`/`channels`/`users` e os objetos dos buckets de teste; o app é criado com `Test.createTestingModule({ imports: [AppModule] }).compile()` + a configuração global de `main.ts`. Um usuário confirmado é logado; o fixture `test/fixtures/sample.mp4` é enviado ao bucket `streamtube-videos-test` em `{id}/source` e a thumbnail em `streamtube-thumbnails-test/{id}/default.jpg`; a linha em `videos` do canal do usuário é criada com `status = 'ready'`, `original_filename = 'sample.mp4'`, `duration_seconds`, `width`, `height` e `thumbnail_key` preenchidos.

#### 1.1. le-video-pronto-pela-url-unica

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/:publicId com token do dono
    - expect: status `200`
    - expect: body com `publicId` igual ao do vídeo, `status: "ready"`, `publicationStatus: "draft"`, `durationSeconds`, `width` e `height` não nulos
    - expect: `thumbnailUrl` não nulo; um `GET` nessa URL retorna `200` com `Content-Type: image/jpeg`

#### 1.2. stream-entrega-url-com-range-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/:publicId/stream com token do dono
    - expect: status `200`
    - expect: body `{ url, expiresAt }` com `url` não vazia e `expiresAt` no futuro
  2. `GET` HTTP direto na `url`, sem `Authorization` e com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: corpo com exatamente 1024 bytes e header `Content-Range` iniciando em `bytes 0-1023/`

#### 1.3. download-entrega-url-com-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/:publicId/download com token do dono
    - expect: status `200` com body `{ url, expiresAt }`
  2. `GET` HTTP direto na `url`
    - expect: status `200`
    - expect: header `Content-Disposition` igual a `attachment; filename="sample.mp4"`

### 2. Estado, autorização e validação

**Setup:** mesmo setup do grupo 1; um segundo vídeo do mesmo dono é criado com `status = 'processing'`, e um segundo usuário confirmado é logado.

#### 2.1. stream-de-video-nao-pronto-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/:publicId/stream com token do dono, para o vídeo em `processing`
    - expect: status `409`
    - expect: body `error: "VIDEO_NOT_READY"`

#### 2.2. outro-canal-ou-inexistente-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/:publicId com o token do segundo usuário, para o vídeo do primeiro
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:publicId/download com o token do segundo usuário, para o vídeo do primeiro
    - expect: status `404`
  3. GET /videos/ZZZZZZZZZZZ com token do dono (formato válido, inexistente)
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 2.3. public-id-invalido-e-anonimo

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. GET /videos/abc com token válido
    - expect: status `400`
  2. GET /videos/:publicId sem header `Authorization`
    - expect: status `401`
