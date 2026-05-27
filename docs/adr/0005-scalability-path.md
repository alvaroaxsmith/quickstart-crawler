# ADR-0005 — Caminho de Escalabilidade: KISS hoje, ports para evolução

**Data:** 24/05/2026
**Status:** Aceito
**Contexto:** SPEC §"Roadmap de Escalabilidade", §6.2

## Contexto

O case exige um sistema "escalável" (§6.2: filas/workers, async/paralelo). Surge a tentação
de adotar infra pesada já no dia 1 — BullMQ + Redis para filas, Fastify + Swagger para
exposição HTTP, Postgres para storage. Cada adição traz custo concreto: dependências, ops,
cognitive load para perfil não-técnico (operador real).

## Decisão

**Não** adotamos BullMQ, Redis, HTTP server, Swagger ou banco relacional agora.
**Adotamos** arquitetura hexagonal estrita com 6 portas estáveis, garantindo que cada eixo
de escalabilidade evolui por **substituição de adapter** (drop-in), sem refactor de domínio.

### Portas estabelecidas

1. `UrlSource` — origem de URLs (arquivo → HTTP/Kafka)
2. `PageFetcher` — busca de página (Playwright → Axios/Cheerio)
3. `ProductExtractor` — extração de Product (API/DOM → GraphQL)
4. `ResultSink` — persistência (arquivos → Postgres/S3/Kafka)
5. `CheckpointStore` — progresso (JSON local → Redis)
6. `JobQueue` — orquestração paralela (Semaphore in-memory → BullMQ/SQS)

### Triggers explícitos de migração

| Métrica observada | Migração disparada |
|---|---|
| > 100k URLs por execução | `InMemorySemaphoreQueue` → `BullMqQueue` |
| > 1 instância concorrente | + `RedisCheckpointStore` |
| Output precisa ser query/streamável | `JsonResultSink` → `PostgresResultSink` ou `S3ResultSink` |
| Outros sistemas consomem o crawler | + `src/adapters/http/` com Fastify + OpenAPI |
| > 5% taxa de bloqueio | + adapter de proxy rotativo (port `PageFetcher` já abstrai) |

## Alternativas consideradas

### Adotar BullMQ desde o dia 1
- ❌ Exige Redis no Docker Compose (custo ops para Lucimara)
- ❌ +2 deps runtime (`bullmq`, `ioredis`)
- ❌ Ganho de performance zero para 1k URLs em 1 máquina (gargalo é Playwright ~2-5s/URL)
- ❌ Resume entre máquinas não é requisito do case
- ✅ Vantagem teórica: dashboard pronto, persistência de jobs — não justificam custo

### Expor HTTP + Swagger desde o dia 1
- ❌ Não há consumidor externo nem requisito de §1-§14
- ❌ CLI é o contrato definido pelo case (`--input`, `--output`, `--resume`)
- ❌ Swagger documenta endpoints inexistentes
- ✅ Quando virar serviço: porta `UrlSource` aceita `HttpUrlSource`, porta `ResultSink` aceita push

### Banco relacional desde o dia 1
- ❌ Schema explícito do case (§4) já é compatível com arquivo JSON
- ❌ Saída em arquivo é o esperado pela equipe avaliadora
- ✅ Quando precisar query: novo `ResultSink` (SQL), zero impacto no domain

## Consequências

**Positivas:**
- 2 dependências runtime (`playwright`, `exceljs`) em vez de 5-7
- Stack roda em qualquer máquina com Node 24 + 1GB RAM
- Operador não-técnico instala e executa em < 5 min
- Cada migração futura = 1 arquivo novo + 1 linha no composition root

**Negativas:**
- Exige disciplina arquitetural — domínio nunca pode importar de adapters
- Lint rule + revisão de PR garantem o invariante
- Risco: confundir "simples" com "ingênuo" — mitigado por testes contra dataset real de 999 URLs

## Validação

- Testes unitários do domain **não importam** nada de `adapters/`, `infrastructure/` ou node_modules de runtime (exceto vitest)
- `tsc --noEmit` + ESLint regra de boundaries
- ADR revisitado a cada release: se algum trigger acima foi disparado, abrir nova ADR

## Referências

- SPEC.md §"Roadmap de Escalabilidade"
- ADR-0003 (hexagonal) — pré-requisito desta decisão
- "The Twelve-Factor App" — config, processes, concurrency
