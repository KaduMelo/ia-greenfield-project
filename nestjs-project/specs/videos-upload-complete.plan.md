---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` fecha o handshake de upload. O cliente informa a lista `{ partNumber, etag }` das partes enviadas direto ao storage, e a API chama `CompleteMultipartUpload`, confere o tamanho real via `HeadObject` contra o `fileSize` declarado e transiciona o vídeo para `processing`, enfileirando o job `process-{id}` na fila `video-processing` só depois do commit. Divergência de tamanho apaga o objeto e leva o vídeo a `error` (`422 UPLOAD_SIZE_MISMATCH`). Rejeição do storage (parte ausente/ETag inválido) mantém o vídeo em `uploading` (`422 UPLOAD_COMPLETION_FAILED`). Só o dono do canal pode concluir; os outros recebem `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Conclusão do upload

**Setup:** `beforeEach` limpa `videos`/`channels`/`users`, os objetos dos buckets de teste e a fila `video-processing` sob o `QUEUE_PREFIX` de teste; o app é criado com `Test.createTestingModule({ imports: [AppModule] }).compile()` + a configuração global de `main.ts`. Um usuário confirmado é logado; um vídeo é criado via `POST /videos` com `fileSize` igual ao tamanho de um buffer de teste (6MiB), e as partes são enviadas por `PUT` nas URLs pré-assinadas, guardando os `ETag`s.

#### 1.1. conclui-e-enfileira-processamento

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos/:id/upload/complete com token do dono e body `{ "parts": [ { "partNumber": 1, "etag": "<etag-1>" }, ... ] }` com todas as partes enviadas
    - expect: status `200`
    - expect: body `{ id, publicId, status: "processing" }`
  2. Consultar a linha em `videos` e a fila `video-processing`
    - expect: `status = 'processing'`, `size_bytes` igual ao tamanho do buffer e `upload_id` nulo
    - expect: existe um job `process-{id}` com dados `{ videoId: id }`

#### 1.2. divergencia-de-tamanho-marca-erro-e-apaga-objeto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. Criar um vídeo via `POST /videos` declarando `fileSize` maior que os bytes realmente enviados nas partes (todas as partes enviadas, último bloco menor que o declarado)
    - expect: status `201`
  2. POST /videos/:id/upload/complete com todas as partes e `ETag`s enviados
    - expect: status `422`
    - expect: body `error: "UPLOAD_SIZE_MISMATCH"`
  3. Consultar a linha e o bucket `streamtube-videos-test`
    - expect: `status = 'error'` e `processing_error = 'UPLOAD_SIZE_MISMATCH'`
    - expect: o objeto `{id}/source` não existe no bucket
    - expect: nenhum job `process-{id}` na fila

#### 1.3. parte-faltando-mantem-uploading

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. Criar um vídeo cuja quantidade de partes seja ≥ 2 e enviar apenas a parte 1
    - expect: `PUT` da parte 1 retorna `200` com `ETag`
  2. POST /videos/:id/upload/complete com `parts` contendo a parte 1 e uma parte 2 com `etag` inventado
    - expect: status `422`
    - expect: body `error: "UPLOAD_COMPLETION_FAILED"`
  3. Consultar a linha em `videos`
    - expect: `status = 'uploading'` e `upload_id` inalterado

### 2. Estado, autorização e validação

**Setup:** mesmo setup do grupo 1; um segundo usuário confirmado é logado para os cenários de outro canal.

#### 2.1. conclusao-repetida-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. Concluir o vídeo com sucesso (como no cenário 1.1)
    - expect: status `200`
  2. POST /videos/:id/upload/complete de novo, com o mesmo body
    - expect: status `409`
    - expect: body `error: "INVALID_VIDEO_STATE"`

#### 2.2. outro-canal-recebe-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos/:id/upload/complete com o token do segundo usuário, para o vídeo do primeiro
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo do primeiro usuário continua em `uploading`

#### 2.3. id-nao-uuid-retorna-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-15T08:13:22Z

**Steps:**
  1. POST /videos/not-a-uuid/upload/complete com token válido e body válido
    - expect: status `400`
