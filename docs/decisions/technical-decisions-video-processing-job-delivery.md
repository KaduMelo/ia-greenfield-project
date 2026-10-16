---
scope_type: ad-hoc
related_phases: [3]
status: decided
date: 2026-10-15
scope_description: "Garantia de entrega do job de processamento de vídeo à fila após o commit no PostgreSQL (fecha o MD-1 do validation da Fase 03)."
---

# Decisões Técnicas — Garantia de Entrega do Job de Processamento de Vídeo

_Subprojetos no escopo:_

- `nestjs-project/` — recebe a lógica de enfileiramento na conclusão do upload e, conforme a opção escolhida, uma tabela de outbox ou um job periódico de reconciliação. É o único subprojeto afetado.
- `next-frontend/` — **sem decisão em aberto**: a garantia de entrega é interna ao backend; o contrato HTTP de conclusão do upload (phase-03-videos/TD-04) não muda com nenhuma das opções.

> **Origem.** Este documento responde ao issue **MD-1** de `docs/phases/phase-03-videos/validation.md`: a phase-03-videos/TD-06 registra que, com uma fila fora do Postgres, "uma queda entre o commit e o enfileiramento perde o job, a menos que exista um outbox ou uma varredura de reconciliação", mas nenhuma TD decidia como essa garantia é dada.

---

## TD-01: Garantia de Entrega do Job de Processamento à Fila

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Na conclusão do upload (phase-03-videos/TD-04), a API grava a mudança de status do vídeo no PostgreSQL e publica o job de processamento na fila. Se a fila for o BullMQ sobre Redis (recomendação de phase-03-videos/TD-06), as duas escritas estão em sistemas diferentes e não compartilham transação: uma queda do processo, ou uma falha do Redis, entre o `COMMIT` e o `queue.add()` deixa o vídeo em `processing` para sempre, sem job nenhum. O "processamento automático" da Fase 03 só é garantido se essa janela estiver fechada ou se houver um mecanismo de recuperação. **Depende de phase-03-videos/TD-06:** se a TD-06 for decidida como pg-boss (Opção B), o enfileiramento acontece na mesma transação do Postgres e esta TD perde o objeto. Nesse caso, a escolha correta aqui é registrá-la como não aplicável.

**Options:**

### Opção A: Transactional outbox
A conclusão do upload grava, na mesma transação da mudança de status, uma linha em uma tabela `outbox` (tipo do evento, payload, `processed_at`). Um relay (processo/loop no worker) lê as linhas pendentes, publica na fila e marca como processadas.
- **Prós:** É o padrão canônico para o problema: a intenção de enfileirar é durável no instante do commit, então nenhum job se perde. Independe da tecnologia de fila. Generaliza para eventos futuros (likes, notificações, Fase 08).
- **Contras:** Mais uma tabela, mais uma migration e um componente relay com polling próprio, para um único produtor e um único tipo de job nesta fase. A entrega continua "pelo menos uma vez" (o relay pode publicar e cair antes de marcar), então o worker precisa ser idempotente de qualquer forma.

### Opção B: Enfileirar após o commit + varredura de reconciliação com `jobId` determinístico
A API faz o commit e em seguida chama `queue.add()` com `jobId` derivado do id do vídeo. Um job periódico (Job Scheduler do BullMQ, `upsertJobScheduler` com `every`) procura vídeos em `processing` há mais de N minutos e os re-enfileira com o mesmo `jobId`. O BullMQ ignora um `add` cujo `jobId` já existe na fila, então a varredura não duplica um job vivo.
- **Prós:** Sem tabela nova: o próprio `status` da linha do vídeo é o registro durável da intenção. Reaproveita a infraestrutura de fila já decidida, sem um segundo mecanismo de polling. A mesma varredura também recupera vídeos cujo job foi perdido por outros motivos (flush do Redis, remoção manual). Testável em integração: criar um vídeo em `processing` sem job, rodar a varredura e verificar que o job aparece na fila.
- **Contras:** No caso raro de perda, a latência até o reprocessamento é o intervalo da varredura mais o limiar. A deduplicação por `jobId` só vale enquanto o job anterior ainda está na fila: um job removido por `removeOnComplete`/`removeOnFail` deixa de contar como duplicata. Por isso a varredura precisa filtrar pelo `status` do banco, e o worker precisa ser idempotente. Os `jobId` não podem conter `:` nem ser puramente numéricos.

### Opção C: Enfileirar após o commit e aceitar a janela como risco documentado
A API faz o commit e chama `queue.add()`. Não há recuperação automática; a perda é registrada como risco conhecido e tratada manualmente.
- **Prós:** Zero código e zero infraestrutura extra; a janela é de milissegundos e exige uma queda exatamente nesse ponto.
- **Contras:** Um vídeo atingido fica em `processing` indefinidamente, e nada detecta nem corrige isso. A capacidade "processamento automático" vira melhor esforço, e nenhum teste consegue afirmar recuperação.

**Recommendation:** **Opção B**. O `status` da linha do vídeo já é um registro durável de "este vídeo precisa ser processado", então uma tabela de outbox duplicaria essa informação para um único produtor e um único tipo de job. Com o `jobId` determinístico, o re-enfileiramento é idempotente pela própria fila, e um Job Scheduler do BullMQ executa a varredura sem precisar de outro mecanismo de agendamento. Sobre a Opção A, a B perde a entrega imediata no caso raro de queda (recuperada no próximo ciclo da varredura) e a generalização para outros eventos. O outbox volta a valer a pena quando aparecer o segundo tipo de evento assíncrono (ex.: notificações da Fase 08). A Opção C fica fora porque deixa a capacidade de processamento automático sem nenhuma garantia verificável.

**Decision:** B (enfileirar após o commit + varredura de reconciliação com `jobId` determinístico)

---

## Decisions Summary

| ID | Scope | Decisão | Recomendação | Escolha |
|----|-------|---------|--------------|---------|
| TD-01 | Backend | Garantia de entrega do job de processamento à fila | B (enfileirar após commit + varredura de reconciliação com `jobId` determinístico) | B |

## Observação para o `/plan-resolve`

O Context7 lista o BullMQ em **v6.3.11** (`/taskforcesh/bullmq`), enquanto `technical-decisions-phase-03-videos.md` registrou "`bullmq` `^5`" a partir do range de peer dependency do `@nestjs/bullmq` 11.0.4. A compatibilidade entre `@nestjs/bullmq` e BullMQ v6 precisa ser confirmada ao fixar as versões no `library-refs.md`.

## Fontes

- [BullMQ — Job IDs (duplicatas ignoradas; jobs removidos não contam como duplicatas)](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/jobs/job-ids.md)
- [BullMQ — Auto-removal of jobs / idempotência](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/queues/auto-removal-of-jobs.md)
- [BullMQ — Job Schedulers (`upsertJobScheduler`)](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/job-schedulers/README.md)
- [Microservices.io — Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
