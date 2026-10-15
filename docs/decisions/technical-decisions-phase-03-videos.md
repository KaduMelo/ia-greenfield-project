---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-03
scope_description: "Armazenamento de objetos, fila de processamento em segundo plano, worker de vídeo (FFmpeg), estratégia de upload de 10GB, URL única, streaming e download da Fase 03."
---

# Decisões Técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojetos no escopo:_

- `nestjs-project/` — recebe o módulo `videos`, a integração com o object storage, o produtor da fila, o worker de vídeo (container separado, mesmo código-fonte), a migration de `videos` e os endpoints de streaming/download. Todas as TDs abaixo tocam este subprojeto.
- `next-frontend/` — **sem trabalho de UI na Fase 03**: os bullets de capacidade da fase em `docs/project-plan.md` não incluem nenhuma entrega de tela (diferente da Fase 02, que lista "Telas de cadastro, login…"). A interface de vídeo entra nas Fases 04–05. As quatro TDs marcadas como `Cross-layer` (TD-03, TD-04, TD-10, TD-11) recebem essa marcação porque definem o contrato exposto ao cliente que o frontend vai consumir nessas fases seguintes — decidi-las por camada mais tarde produziria duas metades incompatíveis de um mesmo handshake. Nenhuma TD exclusiva de frontend pertence a este documento.

> **Ressalva sobre versões de bibliotecas.** O servidor MCP `context7` ainda não estava disponível na sessão que produziu esta pesquisa (ele foi adicionado ao `.mcp.json` nesta mesma branch, mas exige reinício da sessão). As versões citadas abaixo vêm de fontes oficiais (npm e documentação do fornecedor) consultadas via busca web em 2026-08-03 e estão marcadas como **a confirmar via context7 durante o `/plan-resolve`**, que é o estágio dono do `library-refs.md`. Conforme o `CLAUDE.md` → "Library Documentation Lookup", qualquer divergência encontrada nesse estágio deve ser sinalizada antes da implementação.

---

## TD-01: Biblioteca Cliente do Object Storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O backend de armazenamento em si **não** é uma decisão em aberto — o `docs/diagrams/software-arch.mermaid` já o fixa como "S3 or MinIO", ou seja, MinIO no Docker local com a mesma API do S3 em produção. O que está aberto é qual cliente Node a API e o worker usam para conversar com ele, porque essa escolha determina se a troca para o S3 real em produção é uma mudança de configuração ou de código, e se URLs pré-assinadas de multipart (exigidas pela TD-03) são sequer expressáveis.

**Options:**

### Opção A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`
SDK oficial da AWS v3, modular. Aponta para o MinIO via `endpoint` + `forcePathStyle: true`; o mesmo código aponta para o S3 real removendo essas duas opções.
- **Prós:** Expõe a API completa de multipart (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`) e consegue pré-assinar *qualquer* comando via `getSignedUrl`, do que a TD-03 depende. Zero mudança de código entre MinIO e S3. Com releases ativas (client-s3 `3.1101.0`, presigner `3.1097.0` em 2026-08).
- **Contras:** Superfície de dependência maior que a de um cliente específico do MinIO; a API baseada em objetos de comando é mais verbosa que um wrapper de conveniência.

### Opção B: `minio` (SDK JS oficial do MinIO)
Cliente próprio do MinIO, com API mais simples de um método por operação.
- **Prós:** API ergonômica (`presignedPutObject`, `fPutObject`); instalação menor.
- **Contras:** Amarra o código ao cliente do MinIO em um projeto cujo alvo declarado é armazenamento compatível com S3; pré-assinar URLs de partes individuais do multipart não é um fluxo documentado de primeira classe (está registrado como pedido em aberto em `minio/minio-js#772`). Trocar para o S3 depois significa reescrever a camada de storage.

### Opção C: Wrapper da comunidade NestJS (ex.: `nestjs-minio-client`)
Um invólucro fino de DI sobre a Opção B.
- **Prós:** Já entrega um injectable pronto.
- **Contras:** Herda todos os contras da Opção B e ainda adiciona uma dependência de comunidade pequena no caminho crítico. O injectable tem ~15 linhas escritas à mão sobre a Opção A, o que o projeto já faz para outras integrações.

**Recommendation:** **Opção A** — a TD-03 exige pré-assinar requisições `UploadPart` individuais, o que é primeira classe no `@aws-sdk/s3-request-presigner` e não é fluxo documentado no SDK do MinIO. Usar o SDK da AWS contra o MinIO também torna a migração para produção uma troca de dois valores de configuração em vez de uma reescrita, o que combina com o enquadramento "S3 or MinIO" já assumido no diagrama de arquitetura. Custo: dependência mais pesada e API de comandos mais verbosa.

**Decision:** A (`@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Organização de Buckets e Chaves de Objeto

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Vídeos e thumbnails têm perfis de acesso opostos: o vídeo de origem é grande, privado e servido por URLs assinadas de vida curta; a thumbnail é pequena e lida em toda página de listagem (Fases 04–05 e 07). O layout é citado por pelo menos quatro lugares que precisam concordar — `compose.yaml` (bootstrap dos buckets), a configuração de storage, a API (pré-assinatura e remoção) e o worker (escrita da thumbnail) — portanto é um contrato entre componentes, não um detalhe de implementação.

**Options:**

### Opção A: Bucket único, separado por prefixo
Um bucket (`streamtube`), com chaves como `videos/{videoId}/source{ext}` e `thumbnails/{videoId}/default.jpg`.
- **Prós:** Um bucket só para criar e configurar; apagar um vídeo é uma remoção por prefixo; uma configuração de CORS e uma de lifecycle para manter.
- **Contras:** Não dá para conceder às thumbnails uma política de leitura pública diferente da dos vídeos sem regras de política por prefixo, que são mais trabalhosas que as por bucket. Regras de lifecycle (ex.: expirar uploads multipart abandonados) precisam ser escopadas por prefixo.

### Opção B: Dois buckets por perfil de acesso
`streamtube-videos` (sempre privado) e `streamtube-thumbnails` (candidato a leitura pública / CDN no futuro).
- **Prós:** Política de acesso, lifecycle e um futuro CDN na frente são expressos na granularidade de bucket, que é a unidade natural no S3. A expiração de multipart abandonado vale só para o bucket de vídeos.
- **Contras:** Dois buckets para provisionar e manter em sincronia; apagar um vídeo toca dois buckets; dois conjuntos de chaves de configuração.

### Opção C: Um bucket por canal
Um bucket por canal, com chaves por id de vídeo.
- **Prós:** Isolamento natural por tenant.
- **Contras:** O S3 limita buckets por conta (100 por padrão, 1000 com aumento) — isso não sobrevive a uma plataforma com mais que algumas centenas de usuários. Rejeitada por escalabilidade; listada apenas porque "isolar por tenant" é um primeiro instinto comum.

**Recommendation:** **Opção B** — as duas classes de ativo diferem genuinamente em política de acesso, e as Fases 05 e 07 vão ler thumbnails em toda renderização de grid enquanto os vídeos de origem permanecem privados para sempre. Expressar isso no nível de bucket custa uma chave de configuração a mais agora e evita retrabalhar políticas por prefixo depois. Chavear ambos por `{videoId}` mantém a exclusão como uma operação de duas chamadas, não de busca. Se você preferir adiar, a Opção A não é errada — está a um refactor de virar a B.

**Decision:** B (dois buckets por perfil de acesso)

---

## TD-03: Estratégia de Upload para Arquivos de até 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Esta é a restrição definidora da fase. Dois fatos duros delimitam o espaço de opções, ambos verificados na documentação da AWS: um `PutObject` único do S3 aceita **no máximo 5GB**, logo um arquivo de 10GB **não pode** ser enviado por um único PUT pré-assinado sob nenhuma configuração; e o multipart upload aceita até 10.000 partes de 5MB–5GB cada. Qualquer estratégia que roteie 10GB pelo processo NestJS também mantém uma requisição Express aberta durante toda a transferência, que é exatamente a falha contra a qual o plano do projeto alerta ("sem impacto na performance"). O handshake atravessa cliente e servidor, então precisa ser decidido uma vez para os dois lados.

**Options:**

### Opção A: Multipart upload do S3 com URLs pré-assinadas por parte, orquestrado pela API
A API cria o multipart upload e devolve um lote de URLs pré-assinadas de `UploadPart`; o cliente faz PUT das partes direto no storage (em paralelo, repetindo partes individuais em caso de falha) e reporta de volta a lista `{PartNumber, ETag}`; a API chama `CompleteMultipartUpload`.
- **Prós:** É a única opção que atende 10GB nativamente. Os bytes nunca tocam a API — sem memória Node, sem requisição presa, sem limite de body para aumentar. Partes que falham são repetidas individualmente em vez de reiniciar 10GB. Funciona de forma idêntica em MinIO e S3.
- **Contras:** Handshake de múltiplos passos que o cliente precisa implementar corretamente. Exige CORS no bucket com `ETag` em `ExposeHeaders`, senão o navegador não consegue ler os ETags das partes. Uploads abandonados deixam partes cobráveis até uma regra de lifecycle recolhê-las.

### Opção B: Fazer o upload transitar pela API em stream até o storage
O cliente faz POST para a API, que canaliza o stream da requisição para o storage via `Upload` do `@aws-sdk/lib-storage`.
- **Prós:** Endpoint único; o cliente faz um upload comum; a API pode inspecionar os bytes em trânsito.
- **Contras:** Todo byte atravessa a API — um upload de 10GB ocupa uma conexão Node por toda a sua duração, e N uploads concorrentes escalam memória e sockets linearmente. Uma conexão caída reinicia do zero. É exatamente o padrão que o enunciado aponta como reprova automática ("passar o arquivo de 10GB pela API de forma que trave o sistema").

### Opção C: Servidor do protocolo `tus` (`@tus/server`) com store S3
Sobe um endpoint tus que aceita chunks via `PATCH` e persiste no S3 por baixo.
- **Prós:** Protocolo aberto com semântica real de retomada após reinício do navegador, que o multipart cru não tem (os ETags das partes se perdem no reload, a menos que sejam persistidos). Existem bibliotecas cliente para toda plataforma.
- **Contras:** Os chunks ainda transitam pelo host da API, abrindo mão do principal benefício da Opção A. Adiciona um protocolo e um componente de servidor fora do pipeline de requisições do NestJS (integração de auth própria, roteamento próprio). Mais pesado que o requisito declarado da fase, que pede 10GB sem travar — não retomada entre sessões.

**Recommendation:** **Opção A** — é a única que supera o teto de 5GB do PUT único sem rotear 10GB pelo NestJS, e reaproveita infraestrutura já implicada pela TD-01. O que se perde em relação à Opção C é a retomada após um reload do navegador; isso é recuperável depois persistindo a sessão de upload (`uploadId` + partes recebidas) no servidor, o que a TD-04 já armazena — então escolher a A não fecha a porta para a principal vantagem da C.

**Decision:** A (multipart S3 + URLs pré-assinadas por parte)

---

## TD-04: Ciclo de Vida da Sessão de Upload e Handshake de Conclusão

**Scope:** Cross-layer

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A fase exige que a linha do vídeo exista como rascunho *quando o upload começa*, não quando termina. Com o upload direto ao storage da TD-03, a API nunca vê os bytes, então ela precisa de um sinal explícito de que o objeto está completo e o processamento pode começar. Depende da TD-03. Este é o contrato de handshake que o frontend implementa na Fase 04, daí a marcação Cross-layer.

**Options:**

### Opção A: Conclusão dirigida pelo cliente
`POST /videos` cria a linha em rascunho + o multipart upload e devolve `videoId`, `uploadId` e as URLs pré-assinadas das partes. O cliente envia as partes e então chama `POST /videos/{id}/upload/complete` com a lista `{PartNumber, ETag}`. A API chama `CompleteMultipartUpload`, muda o status e enfileira o job de processamento.
- **Prós:** Totalmente síncrono e testável ponta a ponta com `supertest` — nenhum callback externo é necessário para fechar o ciclo. A API mantém a autorização nas duas pontas do handshake. O abandono é detectável (rascunho sem conclusão após N horas).
- **Contras:** Um cliente que envia todas as partes e some deixa um rascunho preso; exige um coletor. Confia no cliente para reportar a lista de partes, então a conclusão precisa ser verificada contra o storage (ver TD-05).

### Opção B: Notificação de evento do storage
Notificação de bucket do MinIO/S3 dispara na criação do objeto para um webhook na API, que muda o status e enfileira.
- **Prós:** Autoritativo — o sinal vem do storage, não do cliente, então não pode ser pulado nem forjado. Sobrevive a um cliente que desconecta depois da última parte.
- **Contras:** Exige configuração de notificação no `compose.yaml` e um endpoint de webhook não autenticado (ou protegido à parte). Nos testes, o ciclo passa a depender da entrega assíncrona do MinIO, deixando o e2e sensível a temporização. A configuração de notificação difere entre MinIO e S3 real (alvos SQS/SNS/Lambda).

### Opção C: Reconciliação agendada
Um job periódico lista uploads em andamento e promove aqueles cujo objeto já existe.
- **Prós:** Não depende de cooperação do cliente nem de webhook.
- **Contras:** Adiciona latência proporcional ao intervalo do poll antes de o processamento começar; custa uma listagem de bucket por ciclo. Resolve o problema do coletor, mas é um caminho primário ruim.

**Recommendation:** **Opção A**, com o coletor agendado de rascunhos abandonados adiado para uma fase futura (fora dos bullets desta fase). Ela mantém todo o fluxo dentro do contrato HTTP, que é o que o torna testável em e2e com o `supertest` já existente no projeto, e concentra a autorização em um lugar só. A Opção B é a resposta mais robusta para produção e merece ser revisitada quando a plataforma tiver tráfego real; adotá-la agora faria a suíte e2e da fase depender da entrega assíncrona de notificações do MinIO.

**Decision:** A (conclusão dirigida pelo cliente)

---

## TD-05: Imposição de Limite de Tamanho e Content-Type no Upload

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Uma vez que a TD-03 entrega URLs pré-assinadas ao cliente, a API deixa de estar no caminho dos bytes e portanto não consegue contá-los enquanto chegam. O teto de 10GB e a regra "isto precisa ser um vídeo" ainda têm de ser impostos em algum lugar, ou o limite é decorativo. Note que o truque usual — uma policy de `POST` pré-assinado com `content-length-range` — **não está disponível aqui**, porque o POST pré-assinado não conduz uploads multipart; é um upload de formulário em requisição única, sujeito ao mesmo teto de 5GB.

**Options:**

### Opção A: Declarar no início, orçar as partes, verificar na conclusão
O cliente declara `fileSize` e `contentType` ao criar o upload; a API rejeita valores fora da política, emite apenas a quantidade de URLs de parte que aquele tamanho exige e, na conclusão, chama `HeadObject` para comparar o `ContentLength` real com o tamanho declarado — abortando e marcando o vídeo como `error` em caso de divergência.
- **Prós:** Impõe o teto real no único momento em que o tamanho verdadeiro é conhecível. O orçamento de partes limita o abuso antecipadamente (nenhuma URL emitida além do tamanho declarado). Uma chamada `HeadObject` extra por upload.
- **Contras:** A detecção é a posteriori — o cliente ainda consegue empurrar bytes acima do limite para o storage antes de ser rejeitado, então o caminho de aborto precisa realmente apagar o objeto.

### Opção B: Confiar no tamanho declarado e limpar com regras de lifecycle
Validar os valores declarados e depois confiar numa regra de lifecycle do bucket para expirar objetos incompletos ou acima do limite.
- **Prós:** O mais simples; nenhuma chamada extra no caminho feliz.
- **Contras:** Nada de fato impõe os 10GB — a capacidade declarada vira inverificável, e nenhum teste consegue afirmá-la.

### Opção C: Rotear os bytes pela API para contá-los
Reverte a TD-03.
- **Prós:** Imposição exata, byte a byte.
- **Contras:** Contradiz diretamente a TD-03 e o requisito central da fase. Listada apenas para tornar o trade-off explícito: abrir mão do caminho dos bytes é o que compra a capacidade de 10GB, e a verificação a posteriori é o preço.

**Recommendation:** **Opção A** — é a imposição mais forte compatível com a TD-03, e produz algo testável: um teste de integração pode concluir um upload cujo tamanho real excede o declarado e afirmar que o vídeo termina em `error` com o objeto apagado. O content-type é validado contra uma allowlist no início e reconferido na saída do probe da TD-08, então um cliente que mente no `contentType` é pego pelo ffprobe em vez de ser confiado.

**Decision:** A (declarar, orçar partes, verificar na conclusão)

---

## TD-06: Tecnologia de Fila para Processamento em Segundo Plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Esta é a principal decisão de stack da fase — o `docs/diagrams/software-arch.mermaid` marca o container de Message Queue explicitamente como `TBD`. A carga é de um único tipo de job (processar um vídeo enviado), de longa duração (minutos em um arquivo grande), com necessidade de concorrência limitada (FFmpeg é pesado de CPU), retentativa com backoff e um estado terminal de falha alimentando a TD-12. A imagem do container roda Node 25.6, então o piso de versão do Node de todas as opções está satisfeito.

**Options:**

### Opção A: BullMQ + Redis, via `@nestjs/bullmq`
Fila sobre Redis com integração oficial do NestJS (`@nestjs/bullmq` 11.0.4, declarando `^10 || ^11` para NestJS e `^5` para BullMQ).
- **Prós:** Retentativa com backoff exponencial, limite de concorrência por worker, jobs atrasados, progresso de job e um conjunto de jobs falhos vêm todos prontos — exatamente o conjunto de recursos que esta carga precisa, sem nada para escrever à mão. O pacote oficial do Nest faz `@Processor`/`@InjectQueue` seguirem o mesmo idioma de DI do resto da base. Maior ecossistema para este formato de problema.
- **Contras:** Adiciona o Redis como nova dependência de infraestrutura e novo modo de falha. O enfileiramento não é transacional com a escrita no Postgres, então uma queda entre o commit e o enfileiramento perde o job, a menos que exista um outbox ou uma varredura de reconciliação — o worker precisa ser idempotente de qualquer forma.

### Opção B: `pg-boss` sobre o PostgreSQL já existente
Fila de jobs construída sobre o `SKIP LOCKED` do Postgres; a v10 exige Node 20+/PG 13+ (o projeto roda PG 17) e adicionou dead-letter queues.
- **Prós:** **Zero infraestrutura nova** — a stack do Compose ganha um worker, mas nenhum broker. O enfileiramento pode compartilhar a transação que insere/atualiza a linha do vídeo, eliminando a janela de job perdido que a Opção A tem. Os jobs são inspecionáveis com SQL puro, o que combina com um projeto que já tem um servidor MCP de Postgres configurado.
- **Contras:** Não há pacote oficial do NestJS — o módulo, o registro dos processadores e o tratamento de shutdown são escritos à mão. O pg-boss é dono do próprio schema e gerencia as próprias migrations, o que fica desconfortável ao lado da disciplina explícita de migrations TypeORM do projeto. A carga de polling do worker recai sobre a mesma instância de banco que serve as leituras da API.

### Opção C: RabbitMQ via `@nestjs/microservices`
Um broker de verdade com transporte de primeira parte no Nest.
- **Prós:** Broker de mensageria feito para isso; o Nest tem transporte RMQ embutido; é o que mais literalmente corresponde à caixa genérica "Message Queue" do diagrama C4.
- **Contras:** A maior pegada operacional das três. Retentativa atrasada com backoff não é nativa — exige dead-letter exchanges ou o plugin de mensagens atrasadas. Topologias de roteamento e bindings de exchange são capacidade que a fase não usa: há um produtor, um consumidor e um tipo de job.

**Recommendation:** **Opção A (BullMQ + Redis)** — os requisitos reais da carga são concorrência limitada, retentativa com backoff e um estado de falha, e o BullMQ entrega os três nativamente atrás de um pacote oficial do NestJS, enquanto o RabbitMQ exigiria construir o backoff com dead-letter exchanges para uma fila de um único tipo de job. O custo honesto é um quarto container de infraestrutura e um enfileiramento não transacional: **a Opção B é genuinamente competitiva** e vence nesses dois pontos, perdendo em encaixe de ecossistema e por trazer um segundo mecanismo de migrations para dentro de um projeto cuja disciplina de migrations é explícita. Se "nenhuma infraestrutura nova" pesar mais que "integração oficial do Nest", a B é a escolha certa — esta é a única TD deste documento em que as duas opções líderes estão próximas.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** bullmq, @nestjs/bullmq

---

## TD-07: Topologia de Implantação do Worker de Vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O diagrama de arquitetura modela o Video Worker como um container próprio. Onde o código dele mora e como ele sobe determina se compartilha entidades, configuração e o contrato da fila com a API, e se a carga de CPU do FFmpeg pode inanir o atendimento de requisições HTTP. Depende da TD-06.

**Options:**

### Opção A: Mesmo código-fonte, serviço separado no Compose, contexto Nest standalone
Um segundo entrypoint (`src/worker/main.ts`) sobe um application context do Nest — sem listener HTTP — importando apenas os módulos de que o worker precisa. Serviço próprio no Compose e imagem própria (Node + FFmpeg instalado).
- **Prós:** Entidades, configuração, serviço de storage e contrato da fila são compartilhados por import, então produtor e consumidor não podem divergir. Roda no próprio container, então a CPU do FFmpeg nunca compete com o event loop da API, e escala de forma independente (`--scale`). Um `npm install`, um tsconfig, uma suíte de testes.
- **Contras:** Um segundo Dockerfile (a imagem da API não tem FFmpeg). Requer cuidado para que o entrypoint do worker não importe controllers HTTP transitivamente.

### Opção B: Processador em processo, dentro do container da API
Registrar o processador do BullMQ dentro do `AppModule`; nenhum serviço novo.
- **Prós:** Nada novo para construir ou orquestrar; a fiação mais simples possível.
- **Contras:** FFmpeg em um arquivo de 10GB satura a CPU no mesmo container que atende HTTP — a premissa inteira da fase é não bloquear a API. Não dá para escalar workers de forma independente. Contradiz o diagrama de arquitetura, que mostra o Worker como container distinto. Reprova no requisito do enunciado de que um worker suba no Compose.

### Opção C: Projeto npm separado (`video-worker/`)
Um terceiro subprojeto de topo com manifesto próprio.
- **Prós:** Isolamento duro; o worker poderia até usar outra stack.
- **Contras:** Entidades, DTOs e o contrato de payload do job teriam de ser duplicados ou extraídos para um pacote compartilhado — trabalho real, e uma nova superfície de divergência — para um worker que é consumidor natural do mesmo modelo de domínio. O monorepo não tem convenção de `packages/*` onde pendurar uma biblioteca compartilhada.

**Recommendation:** **Opção A** — entrega o isolamento de processo que a fase exige (container separado, CPU independente, escala independente) mantendo uma única fonte de verdade para entidades e para o payload do job, que é o que torna impossível a divergência entre produtor e consumidor. A Opção C compra um isolamento mais forte do que esta fase precisa e seria a primeira coisa no repositório a exigir uma convenção de pacote compartilhado.

**Decision:** A (mesmo código-fonte, container separado, contexto Nest standalone)

---

## TD-08: Estratégia de Invocação do FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa extrair duração e metadados e recortar um frame como thumbnail. O padrão consagrado para isso em Node era o `fluent-ffmpeg` — mas o repositório dele foi **arquivado em 2025-05-22** e a página no npm exibe "Package no longer supported", então adotá-lo agora significa adotar uma dependência abandonada no caminho crítico da fase. Depende da TD-07.

**Options:**

### Opção A: Invocação direta de `ffmpeg`/`ffprobe` do sistema via `child_process`
A imagem do worker instala o FFmpeg pelo gerenciador de pacotes do SO; o código dispara `ffprobe -print_format json -show_format -show_streams` e `ffmpeg -ss … -frames:v 1`, parseando a stdout.
- **Prós:** Zero dependências e nada que possa ser abandonado. O `ffprobe -print_format json` é um contrato estável e documentado que devolve exatamente a duração e os metadados de stream que a fase precisa. Controle total sobre argumentos, timeouts e encerramento do processo. A versão fica fixada pela imagem base do Docker, então é reprodutível.
- **Contras:** A montagem dos argumentos e o parse da stdout são escritos à mão (~50 linhas). Sem API tipada — o JSON do probe precisa da própria interface TypeScript e de validação.

### Opção B: `fluent-ffmpeg`
API encadeada de builder sobre os mesmos binários.
- **Prós:** API ergonômica; `ffprobe()` devolve objeto já parseado; volume enorme de código de exemplo existente.
- **Contras:** **Arquivado e explicitamente sem suporte desde maio de 2025.** Sem correções de segurança, sem caminho de correção para uma incompatibilidade futura com o Node. Ainda assim exige o FFmpeg instalado — é um gerador de linha de comando, não um binding, então adiciona uma camada não mantida sem remover a dependência de sistema.

### Opção C: `ffmpeg-static` / `@ffprobe-installer/ffprobe` + spawn direto
Distribuir os binários como pacotes npm em vez de pacotes do SO, e então dispará-los como na Opção A.
- **Prós:** Versão do FFmpeg fixada no `package.json`; sem mudança no Dockerfile.
- **Contras:** Baixa um binário de ~80MB em tempo de instalação, tornando todo `npm ci` mais lento; as builds empacotadas têm cobertura de codecs mais estreita que uma build de distribuição. Como a TD-07 já dá ao worker um Dockerfile próprio, instalar o FFmpeg ali custa uma linha de `apt install`.

**Recommendation:** **Opção A** — com o `fluent-ffmpeg` arquivado, a escolha real é entre escrever à mão ~50 linhas em torno de um contrato de CLI estável e assumir uma dependência não mantida; o primeiro é claramente melhor para código que precisa sobreviver às fases seguintes. A TD-07 já exige uma imagem dedicada para o worker, então instalar o FFmpeg ali é de graça, o que também elimina a razão de existir da Opção C. Custo: uma interface escrita à mão para a saída JSON do `ffprobe`.

**Decision:** A (`child_process` direto sobre `ffmpeg`/`ffprobe` do sistema)

---

## TD-09: Como o Worker Lê os Bytes do Vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O FFmpeg precisa ler o objeto de origem, que pode ter 10GB. Se ele puxa esses bytes por HTTP ou do disco local decide quanto de disco de rascunho o container do worker precisa — a 10GB por job concorrente, essa é a diferença entre um worker que roda num notebook e um que não roda. Depende da TD-07 e da TD-08.

**Options:**

### Opção A: FFmpeg lê direto de uma URL GET pré-assinada
O worker gera um GET pré-assinado de vida curta e passa a URL como input do FFmpeg; o protocolo HTTP do FFmpeg busca posições com requisições Range, que tanto o MinIO quanto o S3 servem.
- **Prós:** Nenhum disco de rascunho — os bytes passam em stream e são descartados. Probing e extração de um único frame leem apenas as regiões necessárias, então um arquivo de 10GB custa bem menos que 10GB de transferência. A concorrência fica limitada por CPU, não por disco.
- **Contras:** Depende de a URL pré-assinada sobreviver à operação (o TTL precisa cobrir o pior caso de tempo de probe). Arquivos com o átomo `moov` no final causam muitas leituras Range pequenas antes de os metadados de reprodução ficarem disponíveis. Instabilidades de rede aparecem como erros do FFmpeg, que caem no caminho de retentativa da TD-12.

### Opção B: Baixar o objeto inteiro para um volume temporário e processar localmente
`GetObject` para um caminho de rascunho, rodar o FFmpeg contra o arquivo, apagar.
- **Prós:** O mais previsível — I/O de disco local, sem expiração de URL, sem modos de falha de leitura parcial. O mais fácil de raciocinar e depurar.
- **Contras:** Exige ≥10GB de rascunho por job concorrente, que precisa ser provisionado como volume Docker; transfere o arquivo inteiro mesmo que o probe e um frame precisem de uma fração dele; adiciona a latência do download completo antes de o processamento começar.

### Opção C: Híbrido — buscar por Range as regiões de metadados, baixar só se isso falhar
Busca faixas de bytes do cabeçalho/cauda para o probe e recai na Opção B quando o layout do container derrotar essa abordagem.
- **Prós:** Eficiência de melhor caso com um fallback seguro.
- **Contras:** Dois caminhos de código para escrever e testar numa fase que ainda não demonstrou que o fallback é necessário. Prematuro.

**Recommendation:** **Opção A** — probing e extração de um frame tocam uma fração pequena de um arquivo de 10GB, então ler por Range evita provisionar dezenas de gigabytes de volume de rascunho para uma stack Docker local. O trade-off é honesto: a Opção B é mais simples e mais previsível, e é a retirada correta caso a leitura por HTTP se mostre instável contra o MinIO durante a implementação. A Opção C só faz sentido depois que a A falhar de fato.

**Decision:** A (FFmpeg lê de URL GET pré-assinada)

---

## TD-10: Identificador de URL Única do Vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador público curto e livre de colisão — o `docs/project-plan.md` § Pontos de Atenção pede "uma URL curta e única que nunca conflite". É a chave pública de rota a partir da qual o frontend monta `/watch/{id}` na Fase 05, então seu formato é um contrato. Uma restrição de stack é decisiva: o `nestjs-project/tsconfig.json` define `module: nodenext` e o `package.json` não declara `"type": "module"`, então o backend compila para **CommonJS** — e o `nanoid` é **ESM-only desde a v4**, sendo a v3 a última linha compatível com CJS.

**Options:**

### Opção A: `nanoid` v3, com coluna `public_id` dedicada
Um id de 11 caracteres seguro para URL, guardado em coluna própria com índice único, separado da chave primária numérica/uuid.
- **Prós:** Curto e opaco — não vaza contagem de linhas nem ordem de criação. Feito para esse fim, amplamente usado, com probabilidade de colisão bem caracterizada. Separar id público de chave primária mantém os joins internos na chave natural.
- **Contras:** Fixa uma **versão major atrás da atual** puramente por compatibilidade com CommonJS, o que é uma dívida de upgrade permanente que qualquer migração futura para ESM terá de revisitar. Adiciona uma dependência.

### Opção B: UUIDv7 como chave primária e id público ao mesmo tempo
Usar um UUID v7 (ordenado no tempo) como chave primária do vídeo e expô-lo diretamente nas URLs.
- **Prós:** Um identificador só, sem segunda coluna e sem segundo índice. Ordenado no tempo, então indexa bem no Postgres, diferente do UUIDv4. Sem problema de ESM — disponível a partir do `crypto` do Node (`randomUUID` é v4; v7 precisa de um helper pequeno ou do `uuid` v11).
- **Contras:** 36 caracteres na URL — o oposto da "URL curta" que o plano pede. Por ser ordenado no tempo, vaza o instante de criação.

### Opção C: Codificação base62 própria sobre `crypto.randomBytes`
Um utilitário de ~20 linhas que sorteia bytes aleatórios e os codifica em base62 num id de 11 caracteres, guardado em coluna `public_id` com índice único.
- **Prós:** Zero dependências e, portanto, nenhum problema ESM/CJS. Mesmo formato de saída e mesmas características de entropia da Opção A. Trivialmente testável em unidade (alfabeto, comprimento, distribuição).
- **Contras:** Geração de identificador escrita à mão, por menor que seja, é código que o projeto passa a ser dono e precisa acertar (viés de módulo em implementações ingênuas é uma armadilha real).

**Recommendation:** **Opção C** — entrega exatamente o que a Opção A entrega, no mesmo comprimento, sem fixar uma dependência uma major atrás para desviar de uma incompatibilidade ESM que o projeto carregaria indefinidamente. A implementação é pequena e delimitada, e amostragem por rejeição sobre um alfabeto de 62 caracteres são ~20 linhas bem compreendidas. Se você preferir não ser dono de código de geração de identificador, a Opção A é a escolha convencional segura e o pin do nanoid v3 é um contorno documentado e comum. A Opção B está fora só pelo comprimento da URL.

**Decision:** C (base62 próprio sobre `crypto.randomBytes`, coluna `public_id`)

---

## TD-11: Entrega de Streaming e Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A reprodução precisa começar sem buscar o arquivo inteiro, e o mesmo objeto também precisa ser baixável. São uma decisão só, não duas: ambas perguntam "quem serve os bytes, e como o cliente é autorizado a lê-los" — a única diferença entre elas é um cabeçalho `Content-Disposition`. O diagrama de arquitetura já desenha `Rel(frontend, storage, "Streams", "HTTPS")`, ou seja, o frontend lendo do storage e não através da API. A opção escolhida amarra o player da Fase 05, daí Cross-layer.

**Options:**

### Opção A: A API emite um GET pré-assinado de vida curta; o storage serve os bytes
`GET /videos/{publicId}/stream` devolve um redirect (ou um payload JSON) carregando uma URL pré-assinada; o elemento de vídeo do navegador conversa então diretamente com o storage, que responde requisições Range com `206 Partial Content` nativamente. O download usa o mesmo mecanismo com `response-content-disposition=attachment` assinado na URL.
- **Prós:** O serviço de bytes nunca toca o Node — a API fica livre durante a reprodução, o que combina com a premissa de não bloqueio da fase e com o diagrama de arquitetura. A semântica de Range/206 vem do storage de graça, então o seek funciona sem código. A autorização permanece na API, expressa como TTL da URL. Idêntico em MinIO e S3, e passível de CDN na frente mais tarde.
- **Contras:** A URL pré-assinada é do tipo bearer — quem a possui consegue ler até ela expirar, então o TTL é o controle de segurança. Exige CORS no bucket para reprodução no navegador. A rotação de URL significa que o player precisa lidar com expiração em vídeos longos.

### Opção B: A API repassa os bytes com `StreamableFile`
A API busca no storage e canaliza para a resposta, parseando o cabeçalho `Range` e emitindo `206` ela mesma.
- **Prós:** Autorização verificada a cada requisição, revogável na hora; nenhuma URL pré-assinada para vazar; nenhuma configuração de CORS.
- **Contras:** Cada cliente assistindo ocupa uma conexão Node por toda a reprodução — o mesmo perfil de recurso que a fase rejeita para uploads, agora aplicado ao caminho de leitura, que tem concorrência muito maior. O tratamento de Range/206 vira código escrito à mão que precisa estar correto. Contradiz o diagrama de arquitetura.

### Opção C: Bucket público, URLs permanentes
Tornar o bucket de vídeos legível por qualquer um e guardar a URL do objeto.
- **Prós:** O mais simples possível; trivialmente cacheável.
- **Contras:** Nenhum controle de acesso, permanentemente — incompatível com a visibilidade `unlisted` da Fase 04, que exige que um vídeo não seja legível sem passar pela aplicação. Fecha uma porta que está a uma fase de distância.

**Recommendation:** **Opção A** — mantém a API fora do caminho dos bytes na operação de maior concorrência do produto, e obtém seek correto por Range/206 do storage em vez de escrevê-lo à mão. O custo é real e deve ser dito com todas as letras: uma URL pré-assinada é um bearer token até expirar, então a revogação fica limitada pelo TTL em vez de ser imediata. A Opção C está desqualificada pelo requisito `unlisted` da Fase 04, não apenas desfavorecida.

**Decision:** A (API emite GET pré-assinado; storage serve Range/206)

---

## TD-12: Ciclo de Status do Vídeo e Tratamento de Falha no Processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O vídeo atravessa pré-cadastro, upload, processamento e então prontidão ou falha. Como isso é representado decide o que a API consegue reportar, o que o painel de gerenciamento da Fase 04 consegue renderizar e o que acontece quando o FFmpeg falha num arquivo corrompido depois de N retentativas. Depende da TD-06 (semântica de retentativa) e da TD-04 (quem dispara a transição).

**Options:**

### Opção A: Uma coluna enum mais um campo de motivo da falha
Enum `status` (`draft` → `processing` → `ready` | `error`) na tabela de vídeos, com `processing_error` guardando o último motivo de falha. Retentativas e backoff pertencem à fila (TD-06); a linha vira `error` apenas quando o job esgota suas tentativas.
- **Prós:** Corresponde diretamente ao ciclo descrito no plano do projeto. Uma coluna para consultar, indexar e expor — listagens filtram por ela trivialmente. Fronteira de responsabilidade clara: estado transitório de retentativa mora na fila, estado terminal mora no banco, sem duplicação a manter em sincronia.
- **Contras:** Sem histórico — só a última falha fica visível. Diagnosticar um vídeo que oscila exige ler os logs da fila/worker.

### Opção B: Coluna enum mais uma tabela de histórico `video_processing_jobs`
Mesma coluna de status, com cada tentativa registrada como uma linha (início, fim, erro, número da tentativa).
- **Prós:** Trilha de auditoria completa; sustenta "contagem de retentativas" e diagnóstico por tentativa numa futura UI administrativa.
- **Contras:** Uma segunda tabela, uma segunda migration e amplificação de escrita a cada tentativa, atendendo a necessidades de observabilidade que nenhum bullet desta fase pede. A fila já retém os jobs falhos com seus stack traces.

### Opção C: Derivar o status do estado da fila em tempo de leitura
Não guardar status; perguntar à fila se há job pendente/ativo/falho para aquele vídeo.
- **Prós:** Fonte única de verdade; impossível dessincronizar.
- **Contras:** Toda listagem de vídeos vira uma consulta à fila — inviável para o painel da Fase 04 e para o grid da Fase 07. O status some assim que os jobs são removidos pela política de retenção. Acopla caminhos de leitura à disponibilidade da fila.

**Recommendation:** **Opção A** — mapeia um-para-um o ciclo declarado no plano e mantém uma separação limpa entre estado transitório de retentativa (responsabilidade da fila) e estado terminal (responsabilidade do banco). A trilha de auditoria da Opção B tem valor real, mas nenhum bullet da Fase 03 exige histórico de tentativas, e o BullMQ já retém os jobs falhos com seus erros; é uma adição limpa depois, se uma visão administrativa precisar.

**Decision:** A (coluna enum + motivo da falha)
**Revisions:**
- 2026-10-15 — O status da Opção A passa a cobrir só o ciclo de processamento (`uploading → processing → ready | error`), e o rascunho vira uma dimensão separada de publicação (`draft` nesta fase; `published` chega na Fase 04). Rationale: AMB-2 do validation da Fase 03. "Rascunho" no bullet de pré-cadastro e o "Fluxo de rascunho → publicação" da Fase 04 são o mesmo estado de publicação. Misturá-lo na coluna de processamento obrigaria a re-modelar a coluna na Fase 04.

---

## TD-13: Estratégia de Testes para Storage, Fila e Worker

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A Fase 03 adiciona três dependências de runtime que as suítes existentes nunca tocaram. O projeto já respondeu à pergunta análoga para e-mail — o `src/test/mailpit.ts` conduz testes de integração contra o container real do Mailpit em vez de um mock — então a questão aqui é se storage/fila/worker seguem esse precedente ou divergem dele. O `nestjs-project/CLAUDE.md` também fixa o contrato de sufixos (`*.spec.ts` proíbe I/O; `*.integration-spec.ts` exige).

**Options:**

### Opção A: MinIO e fila reais do Compose, isolados por suíte
As suítes de integração e e2e conversam com os serviços do Compose, isoladas por buckets de teste dedicados e um prefixo de fila específico de teste. A lógica do worker é testada invocando o processador diretamente contra um fixture pequeno de vídeo real, de modo que o FFmpeg de fato roda sem esperar entrega pela fila.
- **Prós:** Exercita o código que realmente vai para produção — pré-assinatura, conclusão de multipart, leituras Range e parse do ffprobe são exatamente as partes em que um mock codificaria as suposições do autor em vez do comportamento do storage. Estende o precedente já estabelecido com o Mailpit, mantendo uma só filosofia de teste no repositório. Não exige ferramenta nova.
- **Contras:** As suítes dependem da stack do Compose estar de pé e são mais lentas que mocks. Exige um fixture de vídeo versionado (mantido em algumas centenas de KB). Serviços compartilhados exigem isolamento disciplinado, em linha com a regra `--runInBand` já existente.

### Opção B: Mockar os clientes de storage e de fila em todo lugar
Injetar fakes para o cliente S3 e para a fila em todas as suítes.
- **Prós:** Rápido, hermético, não precisa de infraestrutura para rodar os testes.
- **Contras:** O mock afirma o que o autor acredita que o S3 faz — exatamente a classe de bug a que esta fase está mais exposta (tratamento de ETag no multipart, correção da pré-assinatura, semântica de Range). Quebra o precedente do Mailpit. O enunciado rejeita isso explicitamente ("Não mocke o que dá para testar de verdade com a infra do Compose").

### Opção C: Testcontainers — MinIO/Redis efêmeros por suíte
Subir e derrubar containers programaticamente a cada execução.
- **Prós:** Isolamento total entre execuções; sem dependência de uma stack Compose de vida longa; reprodutível em CI sem um passo de Compose.
- **Contras:** Nova dependência e um novo ciclo de vida para gerenciar; a subida de container por suíte é lenta; rodar Docker-in-Docker de dentro do container `nestjs-api` (onde o `CLAUDE.md` manda todos os comandos npm rodarem) é uma complicação real que o projeto não resolveu.

**Recommendation:** **Opção A** — segue o precedente que o projeto já estabeleceu com o Mailpit, não exige ferramenta nova e coloca a superfície de teste exatamente onde o risco desta fase se concentra: pré-assinatura real, conclusão de multipart real, saída real do ffprobe. A Opção C é a melhor resposta para um ambiente de CI sem stack Compose persistente, mas o mandato de que todos os comandos npm rodem dentro do `nestjs-api` faz do Docker-in-Docker um pré-requisito que esta fase não deveria assumir.

**Decision:** A (serviços reais do Compose, isolados por suíte)

---

## Decisions Summary

| ID | Scope | Decisão | Recomendação | Escolha |
|----|-------|---------|--------------|---------|
| TD-01 | Backend | Biblioteca cliente do object storage | A (`@aws-sdk/client-s3` v3 + presigner) | A |
| TD-02 | Backend | Organização de buckets e chaves | B (dois buckets por perfil de acesso) | B |
| TD-03 | Cross-layer | Estratégia de upload de até 10GB | A (multipart S3 + URLs pré-assinadas por parte) | A |
| TD-04 | Cross-layer | Ciclo da sessão de upload e handshake de conclusão | A (conclusão dirigida pelo cliente) | A |
| TD-05 | Backend | Imposição de tamanho e content-type | A (declarar, orçar partes, verificar na conclusão) | A |
| TD-06 | Backend | Tecnologia de fila | A (BullMQ + Redis) — B (pg-boss) em segundo próximo | A |
| TD-07 | Backend | Topologia de implantação do worker | A (mesmo código, container separado) | A |
| TD-08 | Backend | Estratégia de invocação do FFmpeg | A (`child_process` direto) | A |
| TD-09 | Backend | Como o worker lê os bytes do vídeo | A (GET pré-assinado como input do FFmpeg) | A |
| TD-10 | Cross-layer | Identificador de URL única | C (base62 próprio sobre `crypto.randomBytes`) | C |
| TD-11 | Cross-layer | Entrega de streaming e download | A (GET pré-assinado; storage serve Range/206) | A |
| TD-12 | Backend | Ciclo de status e tratamento de falha | A (coluna enum + motivo da falha) | A |
| TD-13 | Backend | Estratégia de testes de storage, fila e worker | A (serviços reais do Compose, isolados por suíte) | A |

---

## Dependências candidatas (a confirmar via context7 no `/plan-resolve`)

| Pacote | Versão observada (2026-08-03) | Finalidade | Condicionada a |
|--------|-------------------------------|------------|----------------|
| `@aws-sdk/client-s3` | `3.1101.0` | Operações S3/MinIO, incluindo multipart | TD-01 |
| `@aws-sdk/s3-request-presigner` | `3.1097.0` | URLs pré-assinadas de parte e de GET | TD-01, TD-03, TD-11 |
| `@nestjs/bullmq` | `11.0.4` (declara NestJS `^10 \|\| ^11`) | Módulo de fila para NestJS | TD-06 (se A) |
| `bullmq` | `^5` | Motor da fila | TD-06 (se A) |
| `pg-boss` | `10.x` (Node ≥20, PG ≥13) | Fila sobre Postgres | TD-06 (somente se B) |
| `nanoid` | `3.x` (última linha CJS) | Geração do id público | TD-10 (somente se A) |
| — | — | FFmpeg/ffprobe via pacote do SO na imagem do worker | TD-08 |

Rejeitados com base em evidência, registrados para não serem revisitados: **`fluent-ffmpeg`** — repositório arquivado em 2025-05-22, npm marcado como "Package no longer supported" (TD-08); **`nanoid` v4/v5** — ESM-only, incompatível com este backend CommonJS (TD-10).

## Fontes

- [Amazon S3 — Uploading objects (limite de 5GB no PUT único)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)
- [Amazon S3 — Limites do multipart upload (10.000 partes; 5MB–5GB por parte)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)
- [Amazon S3 — Visão geral do multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [`@aws-sdk/client-s3` no npm](https://www.npmjs.com/package/@aws-sdk/client-s3)
- [`@aws-sdk/s3-request-presigner` no npm](https://www.npmjs.com/package/@aws-sdk/s3-request-presigner)
- [`@nestjs/bullmq` no npm](https://www.npmjs.com/package/@nestjs/bullmq)
- [BullMQ — guia de NestJS](https://docs.bullmq.io/guide/nestjs)
- [Notas de release do pg-boss 10.0.0](https://github.com/timgit/pg-boss/releases/tag/10.0.0)
- [fluent-ffmpeg — "Phasing out fluent-ffmpeg" (repositório arquivado)](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324)
- [`fluent-ffmpeg` no npm — "Package no longer supported"](https://www.npmjs.com/package/fluent-ffmpeg)
- [nanoid — ERR_REQUIRE_ESM com CommonJS (v4+ é ESM-only)](https://github.com/ai/nanoid/issues/491)
- [minio-js — multipart upload e URLs pré-assinadas](https://github.com/minio/minio-js/issues/772)
