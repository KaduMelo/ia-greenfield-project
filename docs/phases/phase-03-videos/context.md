---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-03T20:19:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-video-processing-job-delivery.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-08-03T20:19:34-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-03T20:19:34-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-03T20:19:34-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-08-03T20:19:34-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-03T20:19:34-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None named in the phase body._

**Deferred subprojects:** _None._

**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Introdução: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública. (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Biblioteca Cliente do Object Storage | decided | A (`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | phase | Backend | Organização de Buckets e Chaves de Objeto | decided | B (dois buckets por perfil de acesso) | — |
| phase-03-videos/TD-03 | phase | Cross-layer | Estratégia de Upload para Arquivos de até 10GB | decided | A (multipart S3 + URLs pré-assinadas por parte) | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Ciclo de Vida da Sessão de Upload e Handshake de Conclusão | decided | A (conclusão dirigida pelo cliente) | — |
| phase-03-videos/TD-05 | phase | Backend | Imposição de Limite de Tamanho e Content-Type no Upload | decided | A (declarar, orçar partes, verificar na conclusão) | — |
| phase-03-videos/TD-06 | phase | Backend | Tecnologia de Fila para Processamento em Segundo Plano | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-07 | phase | Backend | Topologia de Implantação do Worker de Vídeo | decided | A (mesmo código-fonte, container separado, contexto Nest standalone) | — |
| phase-03-videos/TD-08 | phase | Backend | Estratégia de Invocação do FFmpeg | decided | A (`child_process` direto sobre `ffmpeg`/`ffprobe` do sistema) | — |
| phase-03-videos/TD-09 | phase | Backend | Como o Worker Lê os Bytes do Vídeo | decided | A (FFmpeg lê de URL GET pré-assinada) | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Identificador de URL Única do Vídeo | decided | C (base62 próprio sobre `crypto.randomBytes`, coluna `public_id`) | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Entrega de Streaming e Download | decided | A (API emite GET pré-assinado; storage serve Range/206) | — |
| phase-03-videos/TD-12 | phase | Backend | Ciclo de Status do Vídeo e Tratamento de Falha no Processamento | decided | A (coluna enum + motivo da falha) | — |
|     └─ Last revision: 2026-10-15 — O status da Opção A passa a cobrir só o ciclo de processamento (`uploading → pr… | | | | | | |
| phase-03-videos/TD-13 | phase | Backend | Estratégia de Testes para Storage, Fila e Worker | decided | A (serviços reais do Compose, isolados por suíte) | — |
| video-processing-job-delivery/TD-01 | ad-hoc | Backend | Garantia de Entrega do Job de Processamento à Fila | decided | B (enfileirar após o commit + varredura de reconciliação com `jobId` determinístico) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])
- video-processing-job-delivery — `docs/decisions/technical-decisions-video-processing-job-delivery.md` (scope_type: ad-hoc, related_phases: [3])

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-13 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-13, video-processing-job-delivery/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-05 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-13, video-processing-job-delivery/TD-01 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** a TD-03 exige pré-assinar requisições `UploadPart` individuais, o que é primeira classe no `@aws-sdk/s3-request-presigner` e não é fluxo documentado no SDK do MinIO. Usar o SDK da AWS contra o MinIO também torna a migração para produção uma troca de dois valores de configuração em vez de uma reescrita, o que combina com o enquadramento "S3 or MinIO" já assumido no diagrama de arquitetura. Custo: dependência mais pesada e API de comandos mais verbosa.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-02

**Recommendation:** as duas classes de ativo diferem genuinamente em política de acesso, e as Fases 05 e 07 vão ler thumbnails em toda renderização de grid enquanto os vídeos de origem permanecem privados para sempre. Expressar isso no nível de bucket custa uma chave de configuração a mais agora e evita retrabalhar políticas por prefixo depois. Chavear ambos por `{videoId}` mantém a exclusão como uma operação de duas chamadas, não de busca. Se você preferir adiar, a Opção A não é errada — está a um refactor de virar a B.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** é a única que supera o teto de 5GB do PUT único sem rotear 10GB pelo NestJS, e reaproveita infraestrutura já implicada pela TD-01. O que se perde em relação à Opção C é a retomada após um reload do navegador; isso é recuperável depois persistindo a sessão de upload (`uploadId` + partes recebidas) no servidor, o que a TD-04 já armazena — então escolher a A não fecha a porta para a principal vantagem da C.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** com o coletor agendado de rascunhos abandonados adiado para uma fase futura (fora dos bullets desta fase). Ela mantém todo o fluxo dentro do contrato HTTP, que é o que o torna testável em e2e com o `supertest` já existente no projeto, e concentra a autorização em um lugar só. A Opção B é a resposta mais robusta para produção e merece ser revisitada quando a plataforma tiver tráfego real; adotá-la agora faria a suíte e2e da fase depender da entrega assíncrona de notificações do MinIO.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** é a imposição mais forte compatível com a TD-03, e produz algo testável: um teste de integração pode concluir um upload cujo tamanho real excede o declarado e afirmar que o vídeo termina em `error` com o objeto apagado. O content-type é validado contra uma allowlist no início e reconferido na saída do probe da TD-08, então um cliente que mente no `contentType` é pego pelo ffprobe em vez de ser confiado.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** os requisitos reais da carga são concorrência limitada, retentativa com backoff e um estado de falha, e o BullMQ entrega os três nativamente atrás de um pacote oficial do NestJS, enquanto o RabbitMQ exigiria construir o backoff com dead-letter exchanges para uma fila de um único tipo de job. O custo honesto é um quarto container de infraestrutura e um enfileiramento não transacional: **a Opção B é genuinamente competitiva** e vence nesses dois pontos, perdendo em encaixe de ecossistema e por trazer um segundo mecanismo de migrations para dentro de um projeto cuja disciplina de migrations é explícita. Se "nenhuma infraestrutura nova" pesar mais que "integração oficial do Nest", a B é a escolha certa — esta é a única TD deste documento em que as duas opções líderes estão próximas.
**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-07

**Recommendation:** entrega o isolamento de processo que a fase exige (container separado, CPU independente, escala independente) mantendo uma única fonte de verdade para entidades e para o payload do job, que é o que torna impossível a divergência entre produtor e consumidor. A Opção C compra um isolamento mais forte do que esta fase precisa e seria a primeira coisa no repositório a exigir uma convenção de pacote compartilhado.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** com o `fluent-ffmpeg` arquivado, a escolha real é entre escrever à mão ~50 linhas em torno de um contrato de CLI estável e assumir uma dependência não mantida; o primeiro é claramente melhor para código que precisa sobreviver às fases seguintes. A TD-07 já exige uma imagem dedicada para o worker, então instalar o FFmpeg ali é de graça, o que também elimina a razão de existir da Opção C. Custo: uma interface escrita à mão para a saída JSON do `ffprobe`.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** probing e extração de um frame tocam uma fração pequena de um arquivo de 10GB, então ler por Range evita provisionar dezenas de gigabytes de volume de rascunho para uma stack Docker local. O trade-off é honesto: a Opção B é mais simples e mais previsível, e é a retirada correta caso a leitura por HTTP se mostre instável contra o MinIO durante a implementação. A Opção C só faz sentido depois que a A falhar de fato.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** entrega exatamente o que a Opção A entrega, no mesmo comprimento, sem fixar uma dependência uma major atrás para desviar de uma incompatibilidade ESM que o projeto carregaria indefinidamente. A implementação é pequena e delimitada, e amostragem por rejeição sobre um alfabeto de 62 caracteres são ~20 linhas bem compreendidas. Se você preferir não ser dono de código de geração de identificador, a Opção A é a escolha convencional segura e o pin do nanoid v3 é um contorno documentado e comum. A Opção B está fora só pelo comprimento da URL.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** mantém a API fora do caminho dos bytes na operação de maior concorrência do produto, e obtém seek correto por Range/206 do storage em vez de escrevê-lo à mão. O custo é real e deve ser dito com todas as letras: uma URL pré-assinada é um bearer token até expirar, então a revogação fica limitada pelo TTL em vez de ser imediata. A Opção C está desqualificada pelo requisito `unlisted` da Fase 04, não apenas desfavorecida.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** mapeia um-para-um o ciclo declarado no plano e mantém uma separação limpa entre estado transitório de retentativa (responsabilidade da fila) e estado terminal (responsabilidade do banco). A trilha de auditoria da Opção B tem valor real, mas nenhum bullet da Fase 03 exige histórico de tentativas, e o BullMQ já retém os jobs falhos com seus erros; é uma adição limpa depois, se uma visão administrativa precisar.
**Libraries:** —

**Revisions:**
- 2026-10-15 — O status da Opção A passa a cobrir só o ciclo de processamento (`uploading → processing → ready | error`), e o rascunho vira uma dimensão separada de publicação (`draft` nesta fase; `published` chega na Fase 04). Rationale: AMB-2 do validation da Fase 03. "Rascunho" no bullet de pré-cadastro e o "Fluxo de rascunho → publicação" da Fase 04 são o mesmo estado de publicação. Misturá-lo na coluna de processamento obrigaria a re-modelar a coluna na Fase 04.

### phase-03-videos/TD-13

**Recommendation:** segue o precedente que o projeto já estabeleceu com o Mailpit, não exige ferramenta nova e coloca a superfície de teste exatamente onde o risco desta fase se concentra: pré-assinatura real, conclusão de multipart real, saída real do ffprobe. A Opção C é a melhor resposta para um ambiente de CI sem stack Compose persistente, mas o mandato de que todos os comandos npm rodem dentro do `nestjs-api` faz do Docker-in-Docker um pré-requisito que esta fase não deveria assumir.
**Libraries:** —

### video-processing-job-delivery/TD-01

**Recommendation:** O `status` da linha do vídeo já é um registro durável de "este vídeo precisa ser processado", então uma tabela de outbox duplicaria essa informação para um único produtor e um único tipo de job. Com o `jobId` determinístico, o re-enfileiramento é idempotente pela própria fila, e um Job Scheduler do BullMQ executa a varredura sem precisar de outro mecanismo de agendamento. Sobre a Opção A, a B perde a entrega imediata no caso raro de queda (recuperada no próximo ciclo da varredura) e a generalização para outros eventos. O outbox volta a valer a pena quando aparecer o segundo tipo de evento assíncrono (ex.: notificações da Fase 08). A Opção C fica fora porque deixa a capacidade de processamento automático sem nenhuma garantia verificável.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: {...` _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options includi... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Fonte: `testing-guide-nestjs-project` → §3 Feature Implementation Checklist.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
