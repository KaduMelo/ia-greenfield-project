---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-15T04:10:34-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1152.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-15T04:10:34-03:00"
  bullmq:
    version: "^6.3.15"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-15T04:10:34-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-15T04:10:34-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-15T04:09:05-03:00"
  docs/decisions/technical-decisions-video-processing-job-delivery.md: "2026-10-15T04:09:05-03:00"
---

# phase-03-videos — Library References

Documentação condensada das bibliotecas decididas nesta fase, obtida via Context7 e conferida contra o registro do npm em 2026-10-15. Refazer a busca quando a TD de origem mudar (o `/plan-resolve` atualiza este arquivo quando o conjunto de libs no `## Decisions Index` diverge do conjunto em cache aqui).

**Versões confirmadas no npm (2026-10-15):** `@aws-sdk/client-s3` 3.1152.0, `@aws-sdk/s3-request-presigner` 3.1152.0, `bullmq` 6.3.15, `@nestjs/bullmq` 12.0.0.

> **Divergência sinalizada e resolvida.** O documento de decisões registrou "`bullmq` `^5`" e "`@nestjs/bullmq` 11.0.4" (pesquisa de 2026-08-03). Hoje a linha corrente é BullMQ **v6** e `@nestjs/bullmq` **12.0.0**, cujos peers são `bullmq: ^3 || ^4 || ^5 || ^6` e `@nestjs/core`/`@nestjs/common: ^10 || ^11 || ^12`. O par fixado acima é compatível com o NestJS 11 instalado em `nestjs-project/`. Qualquer mudança de comportamento entre BullMQ v5 e v6 que afete as APIs citadas abaixo deve ser checada via Context7 durante o `/implement`.

### @aws-sdk/client-s3

Ver também `### @aws-sdk/s3-request-presigner` abaixo; as duas libs formam o mesmo cliente (o presigner opera sobre o `S3Client`).

### @aws-sdk/s3-request-presigner

Pré-assinatura de comandos do `@aws-sdk/client-s3` via `getSignedUrl`. Detalhes nas subseções abaixo, que valem para as duas libs.

**Source:** `/aws/aws-sdk-js-v3` (Context7), reputação alta. Origem: `phase-03-videos/TD-01` Decision A. Usado por TD-03 (multipart pré-assinado), TD-05 (`HeadObject` na conclusão), TD-09 (GET pré-assinado para o FFmpeg) e TD-11 (GET pré-assinado para stream/download).

#### Cliente apontando para o MinIO

Endpoint customizado no construtor. No MinIO, use `forcePathStyle: true`. Para trocar pelo S3 real, basta remover `endpoint` e `forcePathStyle`. Conforme o `CLAUDE.md`, o host é o nome do serviço do Compose, nunca `localhost`.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://minio:9000', // nome do serviço do Compose
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
```

#### URLs pré-assinadas (`getSignedUrl`)

`getSignedUrl(client, command, { expiresIn })` pré-assina **qualquer** comando. O `expiresIn` padrão é **900 s** quando omitido. O mesmo mecanismo cobre `UploadPartCommand` (uma URL por parte), `GetObjectCommand` (stream, download e input do FFmpeg) e, no download, `ResponseContentDisposition: 'attachment; filename="..."'` no próprio `GetObjectCommand`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
```

#### Ciclo do multipart (TD-03 / TD-04 / TD-05)

- `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`.
- `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` → **pré-assinado** e entregue ao cliente (partes de 5MB a 5GB, até 10.000 partes).
- `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } })`: as `Parts` (`{ PartNumber, ETag }`) precisam estar **ordenadas por `PartNumber`**. O próprio `lib-storage` do SDK ordena antes de completar.
- `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` limpa as partes de um upload que falhou ou divergiu.
- `HeadObjectCommand({ Bucket, Key })` devolve os metadados (`ContentLength`, `ContentType`) sem o corpo. É a verificação de tamanho real da TD-05. `DeleteObjectCommand` segue o mesmo padrão `client.send(command)`.
- **CORS no bucket de vídeos:** o navegador só lê o `ETag` de cada parte se o bucket expuser `ETag` em `ExposeHeaders` (registrado na TD-03).

### bullmq

**Source:** `/taskforcesh/bullmq` (Context7, v6.3.x), reputação alta. Origem: `phase-03-videos/TD-06` Decision A. Também sustenta `video-processing-job-delivery/TD-01` Decision B.

#### Retentativa com backoff exponencial

As retentativas valem por job: `attempts` + `backoff`. O atraso exponencial é `2^(attempts-1) * delay` ms. Um erro `UnrecoverableError` não é retentado. Quando as tentativas se esgotam, o job vai para `failed`, que é o ponto em que a TD-12 grava `error` + `processing_error` no banco.

```typescript
await queue.add('process', { videoId }, {
  jobId: videoId,                          // ver "Job IDs" abaixo
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

#### Concorrência, retenção e shutdown

- A opção `concurrency` do Worker limita quantos jobs rodam em paralelo por processo (o FFmpeg é pesado de CPU).
- `removeOnComplete` / `removeOnFail` aceitam `{ age, count, limit }` para reter jobs concluídos e falhos por tempo e quantidade.
- `await worker.close()` faz o shutdown gracioso: para de pegar jobs novos e espera os ativos terminarem. Não tem timeout.

#### Job IDs: deduplicação (base da varredura da `video-processing-job-delivery/TD-01`)

- Um `add` com `jobId` que já existe na fila é **ignorado** e dispara o evento `duplicated`.
- **Jobs removidos não contam como duplicata.** Depois de `removeOnComplete`/`removeOnFail`, o mesmo `jobId` pode ser enfileirado de novo. Por isso a varredura filtra pelo `status` do banco, e não só pela fila.
- Um `jobId` customizado **não pode conter `:`** nem ser puramente numérico.

#### Job Schedulers (varredura de reconciliação)

`queue.upsertJobScheduler(schedulerId, { every: ms }, { name, data, opts })` cria ou atualiza um produtor de jobs periódicos. Chamar de novo com o mesmo id só atualiza as configurações, então o upsert pode rodar a cada boot do worker.

```typescript
await queue.upsertJobScheduler(
  'reconcile-stuck-videos',
  { every: 5 * 60 * 1000 },
  { name: 'reconcile', data: {} },
);
```

### @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` (Context7, `content/application/queues.md`), reputação alta. Origem: `phase-03-videos/TD-06` Decision A. Peers da 12.0.0: `bullmq ^3–^6`, `@nestjs/core`/`@nestjs/common` `^10 || ^11 || ^12`.

#### Registro do módulo

A conexão vem de `forRootAsync`, alinhada à convenção herdada de config com `registerAs` e injeção por `ConfigType`. Cada fila é registrada com `registerQueue` ou `registerQueueAsync`, informando o `name`.

```typescript
BullModule.forRootAsync({
  useFactory: () => ({ connection: { host: 'redis', port: 6379 } }), // nome do serviço do Compose
});
BullModule.registerQueue({ name: 'video-processing' });
```

#### Produtor e consumidor

- Produtor: `@InjectQueue('video-processing') private queue: Queue`, com `Queue` importado de `bullmq`.
- Consumidor: uma classe com `@Processor('video-processing')` que estende `WorkerHost` e implementa `async process(job: Job)`. O valor retornado fica no job. Para jobs nomeados (ex.: `process` e `reconcile` na mesma fila), roteie por `job.name` com `switch`, porque o BullMQ não usa o decorator legado `@Process`.

```typescript
@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    switch (job.name) {
      case 'process': /* ffprobe + thumbnail */ break;
      case 'reconcile': /* re-enfileira vídeos presos em processing */ break;
    }
  }
}
```
