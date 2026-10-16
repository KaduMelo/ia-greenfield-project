---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-15T04:12:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-video-processing-job-delivery.md: "2026-10-15T04:09:05-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Quem pode fazer stream/download de um vídeo enquanto ainda é rascunho na Fase 03"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "'rascunho' é status de processamento ou estado de publicação (Fase 04)?"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-3
    status: resolved
    summary: "Quais 'metadados' extraídos pelo processamento são persistidos"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "Garantia de enfileiramento do job após o commit no Postgres (sem TD)"
    resolved_by: video-processing-job-delivery/TD-01
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Biblioteca Cliente do Object Storage"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Organização de Buckets e Chaves de Objeto"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Estratégia de Upload para Arquivos de até 10GB"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Ciclo de Vida da Sessão de Upload e Handshake de Conclusão"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Imposição de Limite de Tamanho e Content-Type no Upload"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Tecnologia de Fila para Processamento em Segundo Plano"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Topologia de Implantação do Worker de Vídeo"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Estratégia de Invocação do FFmpeg"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Como o Worker Lê os Bytes do Vídeo"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Identificador de URL Única do Vídeo"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Entrega de Streaming e Download"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Ciclo de Status do Vídeo e Tratamento de Falha"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Estratégia de Testes para Storage, Fila e Worker"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "video-processing-job-delivery/TD-01 pending — Garantia de Entrega do Job à Fila"
    resolved_by: video-processing-job-delivery/TD-01
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by video-processing-job-delivery/TD-01)_ — Garantia de enfileiramento do job após o commit no Postgres (sem TD). A TD foi criada via `/research` (`technical-decisions-video-processing-job-delivery.md`, `related_phases: [3]`) e incorporada ao `context.md`; decidida em OQ-14.
- **AMB-1** _(resolved_by clarification)_ — Quem pode fazer stream/download de um vídeo enquanto ainda é rascunho na Fase 03. Decisão do usuário: **somente o dono do canal**. Stream e download exigem autenticação e posse do vídeo. O acesso público/anônimo chega com publicação e visibilidade na Fase 04.
- **AMB-2** _(resolved_by phase-03-videos/TD-12)_ — 'rascunho' é status de processamento ou estado de publicação (Fase 04)? Decisão do usuário: **duas dimensões**. Status de processamento (`uploading → processing → ready | error`) separado do estado de publicação (`draft` nesta fase; `published` na Fase 04). Registrado como Revision 2026-10-15 da TD-12, sem trocar a opção A.
- **AMB-3** _(resolved_by clarification)_ — Quais 'metadados' extraídos pelo processamento são persistidos. Decisão do usuário: **colunas tipadas + `jsonb` bruto**: `duration_seconds`, `width`, `height`, `size_bytes` e mime/container tipados, mais um `jsonb` com a saída bruta do `ffprobe` (codecs, bitrate, fps etc.).
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — Decision A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`.
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — Decision B: dois buckets por perfil de acesso.
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — Decision A: multipart S3 + URLs pré-assinadas por parte.
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — Decision A: conclusão dirigida pelo cliente.
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — Decision A: declarar, orçar partes, verificar na conclusão.
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — Decision A: BullMQ + Redis via `@nestjs/bullmq`.
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — Decision A: mesmo código-fonte, container separado.
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — Decision A: `child_process` direto sobre `ffmpeg`/`ffprobe`.
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — Decision A: FFmpeg lê de URL GET pré-assinada.
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — Decision C: base62 próprio sobre `crypto.randomBytes`.
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — Decision A: GET pré-assinado; storage serve Range/206.
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — Decision A: coluna enum + motivo da falha (com a Revision da AMB-2).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — Decision A: serviços reais do Compose, isolados por suíte.
- **OQ-14** _(resolved_by video-processing-job-delivery/TD-01)_ — Decision B: enfileirar após o commit + varredura de reconciliação com `jobId` determinístico.
