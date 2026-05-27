# Spec: Crawler de Produtos iFood

> Gerado via Spec-Driven Development | Data: 24/05/2026
> Ref: `case.md` — 14 parágrafos cobertos integralmente

---

## ASSUMPTIONS — Validar antes de avançar

```
PREMISSAS QUE ESTOU ADOTANDO:
1. Linguagem: TypeScript + Node.js 20 LTS (ADR-0001: docs/adr/0001-typescript-playwright.md)
2. Páginas do iFood são SPA React com hidratação JS → exigem browser headless (Playwright/Chromium).
   Alternativa testada antes de descartar: HTTP simples (axios + cheerio) — provavelmente retorna shell HTML sem dados.
3. Estratégia primária de extração: interceptar respostas da API interna do iFood
   (marketplace.ifood.com.br/*/items/*) via page.route(); Fallback: parser de DOM.
   Motivo: APIs JSON são mais estáveis que seletores CSS (ADR-0002: docs/adr/0002-api-interception-primary.md).
   ⚠ O endpoint exato da API DEVE ser confirmado na Task B1 antes de codar.
4. Input: CSV de 999 URLs (1.000 linhas incluindo header `url`, CRLF). Todas no domínio ifood.com.br/delivery/.
   Padrão observado: `/delivery/<city-uf>/<merchant-slug>/<merchant-uuid>?item=<item-uuid>` →
   merchantId e itemId são **extraíveis da própria URL** (parser puro, sem rede) e usados para
   (a) logging estruturado, (b) agrupamento por merchant para reúso de BrowserContext, (c) auditoria.
5. Saída: JSON (canônica) + CSV + XLSX (multi-formato como diferencial §13).
6. Concorrência: 8 workers com pool de 2-3 browsers compartilhados (BrowserContext por worker).
   Justificativa: 10 browsers consomem >2GB RAM; contextos isolados resolvem com menos overhead.
7. Checkpoint a cada 25 URLs em arquivo JSON local → permite retomada com flag --resume.
   Comportamento de --resume: pula URLs já processadas no Crawl, mas SEMPRE grava output limpo
   (somente os produtos da sessão atual). Não faz merge com outputs anteriores (KISS).
8. Docker é DIFERENCIAL (§13), não bloqueador. Execução nativa npm é o caminho default.
9. Sem cookies/login: todas as URLs são públicas. Sem credenciais a gerenciar.
   ⚠ **REVISADO (Marco 5):** o iFood **não** renderiza preços sem um endereço setado. Premissa
   atualizada: não há login, mas há **sessão obrigatória** (cookies + localStorage + cache) com
   endereço-âncora. Ver §"Premissa Operacional — Sessão e Endereço".
10. Cumprimos robots.txt e Terms of Service do iFood: requisição cortês com delays (§9).
→ Corrija qualquer premissa errada antes de avançar para o PLANO.
```

---

## Objetivo (§1 — Contexto, §2 — Objetivo)

**O que estamos construindo:** Um sistema crawler/scraper que processa uma lista de até
1.000 URLs de produtos do iFood, extrai dados estruturados de cada produto e persiste
os resultados em arquivo de saída.

**Quem usa:** Equipe avaliadora técnica — executa localmente para verificar funcionamento,
taxa de sucesso, qualidade do código e robustez.

**Definição de "done":**
- Todos os 14 parágrafos do case.md implementados ou endereçados
- Taxa de sucesso ≥ 95% no conjunto fornecido
- README completo, executável em ambiente limpo
- Evidências de execução incluídas

---

## Premissa Operacional — Sessão e Endereço (revisão Marco 5)

**Descoberta empírica (Marco 5, ver `docs/journey.md`):** o iFood **bloqueia a renderização
de qualquer produto** quando não há endereço setado na sessão. Sem endereço:

- O SSR retorna apenas metadata "fria" (logo, descrição estática, `itemId`) — sem preço.
- Nenhuma chamada de API de catálogo é disparada client-side.
- A UI exibe modal "Tivemos um problema por aqui".

**Decisão:** o crawler **requer um profile de browser pré-aquecido** com endereço-âncora.

- **Pré-requisito de host:** Google Chrome instalado (`brew install --cask google-chrome` no macOS).
  O Chromium open-source do Playwright é detectado pelo Cloudflare via TLS fingerprint.
- **Bootstrap automatizado UMA VEZ** (`scripts/bootstrap-address.ts`): script abre Chrome
  real com `playwright-extra` + stealth-plugin, digita endereço-âncora (env
  `ANCHOR_ADDRESS`, default `Avenida Paulista, 1000, São Paulo`), seleciona primeira
  sugestão, clica "Confirmar localização" e exporta profile + storageState. Sem etapa
  manual.
- **Crawler runtime:** todo `BrowserContext` é criado via `launchPersistentContext` apontando
  para `fixtures/browser-profile/`. O endereço-âncora é compartilhado por todos os workers.
- **Cobertura:** algumas URLs (lojas fora da área de entrega do endereço-âncora) **não
  retornarão preço**. Isso é categorizado como erro `OUT_OF_DELIVERY_AREA` no
  `ExecutionReport`, **não** como falha do crawler. Métrica de sucesso é avaliada sobre
  URLs *cobertas* pelo endereço.
- **Anti-Cloudflare em camadas** (ADR-0006):
  1. `channel: 'chrome'` (Chrome real, TLS humano)
  2. `playwright-extra` + `puppeteer-extra-plugin-stealth` (~17 patches anti-detecção, incluindo CDP leaks)
  3. `launchPersistentContext` (profile aquecido com `cf_clearance`)
  4. Flags anti-automation + `ignoreDefaultArgs: ['--enable-automation']`
  5. Init script extra para `navigator.languages` pt-BR e WebGL Intel

**Trade-off explícito:** abandonamos a premissa #9 original ("sem cookies/login") **e**
relaxamos ADR-0001 ("dependências mínimas") para incluir `playwright-extra` +
`puppeteer-extra-plugin-stealth` (2 deps extras de runtime). O crawler deixa de ser
100% stateless e passa a depender de Chrome instalado no host + bootstrap de ~30s.
Em troca, ganhamos acesso aos dados de preço — sem isso o crawler é inviável.

**Categoria nova no domínio:** `OUT_OF_DELIVERY_AREA` adicionada em `CrawlErrorCategory`
(não-transiente, não-retentável).

---

## Tech Stack (§5.1) — Princípio: **NATIVO sempre que possível**

**Filosofia (KISS):** menos dependências = menos surface de risco, menos auditoria, builds mais rápidos e código mais explicativo. Toda dep externa precisa de justificativa clara.

### Dependências de runtime (5 — após Marco 5c)

| Camada | Tecnologia | Versão | Justificativa (por que não nativo) |
|---|---|---|---|
| Runtime | Node.js | 24 LTS | Async I/O, `--env-file`, `util.parseArgs`, `fetch` nativos |
| Linguagem | TypeScript | 5.4+ | Tipagem estática (compile-time only) |
| Browser automation | Playwright | 1.44+ | Única forma viável de interceptar API interna do iFood (SPA) |
| Anti-bot wrapper | playwright-extra | ^4 | Permite acoplar plugins de evasão ao Playwright (Marco 5c) |
| Anti-detecção | puppeteer-extra-plugin-stealth | ^2 | ~17 patches que escondem `navigator.webdriver`, CDP leaks, chrome runtime, etc. — necessário para passar Cloudflare Turnstile do iFood (ADR-0006) |
| XLSX I/O | exceljs | 4.4+ | Formato binário (ZIP+XML); impossível sem lib |

**Pré-requisito de host:** Google Chrome instalado (`brew install --cask google-chrome` no macOS).
O Chromium open-source do Playwright tem TLS fingerprint diferente e é detectado pelo Cloudflare.

### Substituídos por APIs NATIVAS do Node 24

| O que faria | Substítuto nativo | Linhas |
|---|---|---|
| ~~commander~~ flags CLI | `node:util.parseArgs` | ~20 |
| ~~dotenv~~ carregar .env | `node --env-file=.env` (Node 20.6+) | 0 |
| ~~p-limit~~ concorrência | `Semaphore` custom (fila in-memory — diferencial §13) | ~25 |
| ~~p-retry~~ retry+backoff | `retry-with-backoff` custom | ~20 |
| ~~pino~~ logging | Logger JSON custom via `process.stdout.write` | ~30 |
| ~~csv-parse~~ ler URLs | `split('\n')` + escape RFC 4180 simples | ~10 |
| Output CSV escape | Helper inline RFC 4180 | ~10 |
| HTTP genérico | `fetch` global (Node 18+) | 0 |

### Dev only

| Camada | Tecnologia | Versão |
|---|---|---|
| Testes | vitest | 2.x |
| Lint | eslint + @typescript-eslint | 8.x |
| Format | prettier | 3.x |
| Dev runner | tsx | 4.x |
| Containerização | Docker | 24+ |

**Resultado: 3 deps de runtime obrigatórias + 2 condicionais. Tudo o mais é Node nativo ou dev-only.**

---

## Comandos (§5, §7, §10)

```bash
# Instalação
npm install
npx playwright install chromium

# Execução principal
npm start                               # usa input/urls.csv por padrão
npm start -- --input input/urls.csv     # arquivo explícito
npm start -- --input input/urls.csv --concurrency 15 --output output/

# Desenvolvimento
npm run dev                             # ts-node com watch

# Testes
npm test                               # todos os testes
npm run test:coverage                  # com relatório de cobertura
npm run test:unit                      # apenas unitários
npm run test:integration               # apenas integração

# Build
npm run build                          # compila para dist/

# Docker
docker compose up                      # execução completa containerizada
docker compose up --build              # rebuild + execução

# Lint
npm run lint                           # ESLint
npm run lint:fix                       # auto-fix
```

---

## Estrutura do Projeto — Hexagonal/Ports & Adapters (§6.2 — Arquitetura, §7.1 — Código-fonte)

> **Separação por camadas** (skill `clean-ddd-hexagonal`): domínio puro no centro,
> casos de uso orquestram, adapters trocáveis nas bordas. Permite trocar Playwright
> por axios+cheerio sem tocar no domínio; trocar JSON por outro storage sem tocar no parser.

```
crawler-test-v2/
├── src/
│   ├── domain/                         ← núcleo, sem dependências externas
│   │   ├── product.ts                  → Product + factory + validação
│   │   ├── crawl-result.ts             → CrawlResult value object
│   │   ├── execution-report.ts         → ExecutionReport value object
│   │   ├── parsed-ifood-url.ts         → ParsedIfoodUrl + parse-ifood-url (puro)
│   │   ├── group-by-merchant.ts        → agrupa URLs por merchantId
│   │   └── errors.ts                   → CrawlError, CrawlErrorCategory
│   ├── application/                    ← casos de uso
│   │   ├── crawl-products-use-case.ts  → orquestra: lê → fila → fetch → parse → escreve
│   │   └── ports/
│   │       ├── url-source.ts           → port: lê URLs
│   │       ├── page-fetcher.ts         → port: busca página
│   │       ├── product-extractor.ts    → port: extrai Product de página/JSON
│   │       ├── result-sink.ts          → port: persiste Products
│   │       └── checkpoint-store.ts     → port: salva/carrega progresso
│   ├── adapters/                       ← implementações dos ports
│   │   ├── input/
│   │   │   ├── csv-url-source.ts
│   │   │   ├── json-url-source.ts
│   │   │   ├── txt-url-source.ts
│   │   │   └── xlsx-url-source.ts
│   │   ├── fetcher/
│   │   │   ├── playwright-fetcher.ts   → SPA-aware, intercepta API do iFood
│   │   │   └── browser-pool.ts         → gerencia browsers + contexts
│   │   ├── extractor/
│   │   │   ├── ifood-api-extractor.ts  → primário: extrai do JSON interceptado
│   │   │   └── ifood-dom-extractor.ts  → fallback: extrai do DOM renderizado
│   │   ├── storage/
│   │   │   ├── json-result-sink.ts     → products_output.json
│   │   │   ├── csv-result-sink.ts      → products_output.csv
│   │   │   ├── xlsx-result-sink.ts     → products_output.xlsx (diferencial §13)
│   │   │   └── composite-result-sink.ts → escreve em N sinks em paralelo
│   │   └── checkpoint/
│   │       └── file-checkpoint-store.ts
│   ├── infrastructure/                 ← cross-cutting
│   │   ├── config/index.ts             → carrega .env + validação inline
│   │   ├── logger/index.ts             → JSON logger custom (process.stdout.write)
│   │   ├── metrics/metrics-collector.ts → counters, latência p50/p95, throughput
│   │   ├── queue/url-queue.ts          → Semaphore + retry-with-backoff + delay aleatório
│   │   └── cli/index.ts               → util.parseArgs parser de flags
│   └── main.ts                         → composition root
├── tests/
│   ├── unit/
│   │   ├── domain/
│   │   ├── adapters/
│   │   │   ├── input/
│   │   │   ├── extractor/
│   │   │   └── storage/
│   │   ├── application/
│   │   └── infrastructure/
│   │       ├── metrics/
│   │       └── queue/
│   └── integration/
│       └── crawl-3-urls.test.ts
├── fixtures/                           → HTML + JSON reais capturados em B1
├── input/
│   └── urls.csv
├── output/                             → gerado automaticamente
│   ├── products_output.json
│   ├── products_output.csv
│   └── execution_report.json
├── logs/
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── docs/
│   └── adr/
├── .env.example
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

---

## Tipos Centrais (§4 — Dados Extraídos)

> **Regra de negócio:** todos os 7 campos são obrigatórios na saída. Campos não
> disponíveis na página vêm como `null` (não omitir a chave). `status` é 'success'
> se e somente se `title` foi extraído — toda outra falha vira 'error' com mensagem.

```typescript
// src/domain/product.ts

export interface Product {
  title: string | null;
  normal_price: string | null;       // formato preservado: "R$ 39,90"
  discount_price: string | null;     // null se não houver desconto
  product_url: string;               // sempre presente — URL original
  image_url: string | null;
  status: 'success' | 'error';
  error_message: string | null;      // null quando status='success'
}

// Categorias de erro (mapeadas para error_message human-readable)
export type CrawlErrorCategory =
  | 'TIMEOUT'                    // "Timeout ao carregar a página (>30s)"
  | 'HTTP_ERROR'                 // "Servidor retornou HTTP 503"
  | 'NOT_FOUND'                  // "Produto indisponível ou removido (404)"
  | 'BLOCKED'                    // "Acesso bloqueado pelo servidor (CAPTCHA/429)"
  | 'INVALID_URL'                // "URL malformada ou não pertence ao iFood"
  | 'PARSE_FAILURE'              // "Estrutura da página não reconhecida"
  | 'NETWORK_ERROR'              // "Falha de rede após 3 tentativas"
  | 'UNKNOWN';                   // "Erro inesperado: <mensagem>"

// Metadados extraídos da própria URL (sem rede) — usados para logs, agrupamento e auditoria.
// NÃO entram em Product (que respeita o schema obrigatório do §4 do case).
export interface ParsedIfoodUrl {
  raw: string;
  city: string;            // ex: 'sao-paulo-sp'
  merchantSlug: string;    // ex: 'carrefour-hiper---giovani-gronchi-vila-andrade'
  merchantId: string;      // UUID do path
  itemId: string;          // UUID do querystring ?item=
}

export interface CrawlResult {
  product: Product;
  parsed_url: ParsedIfoodUrl;     // sempre presente (parser é puro)
  attempts: number;
  duration_ms: number;
  error_category?: CrawlErrorCategory;
}

export interface ExecutionReport {
  started_at: string;              // ISO 8601
  finished_at: string;
  duration_seconds: number;
  total_urls: number;
  successes: number;
  failures: number;
  success_rate_percent: number;    // ex: 96.3
  errors_by_category: Record<CrawlErrorCategory, number>;
  latency_ms: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
  };
  throughput_urls_per_minute: number;
  output_files: string[];
  config_snapshot: {               // reprodutibilidade
    concurrency: number;
    max_retries: number;
    timeout_ms: number;
  };
}

export interface AppConfig {
  inputFile: string;
  outputDir: string;
  outputFormats: ('json' | 'csv' | 'xlsx')[];
  concurrency: number;
  maxRetries: number;
  timeoutMs: number;
  headless: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  resume: boolean;
  checkpointInterval: number;
  userAgent: string;
  delayMinMs: number;
  delayMaxMs: number;
}

// Resultado bruto de um Fetch — vive no adapter, não no domain
// src/adapters/fetcher/playwright-fetcher.ts
export interface FetchResponse {
  html: string;
  apiJson?: unknown;        // JSON interceptado da API interna do iFood (pode ser undefined)
  httpStatus: number;
  durationMs: number;
}
```

---

## Code Style

```typescript
// Padrão: classes com injeção de dependência, métodos async, erros tipados
// Nunca: callbacks aninhados, any implícito, try/catch genérico silencioso

// src/adapters/extractor/ifood-api-extractor.ts
export class IfoodApiExtractor {
  extract(apiJson: unknown, url: string): Product {
    const data = apiJson as Record<string, unknown>;
    const title = (data['name'] as string) ?? null;
    const normal_price = (data['price'] as string) ?? null;
    const discount_price = (data['discountPrice'] as string) ?? null;

    return {
      title,
      normal_price,
      discount_price,
      product_url: url,
      image_url: (data['imageUrl'] as string) ?? null,
      status: title !== null ? 'success' : 'error',
      error_message: title === null ? 'Campo title ausente na resposta da API' : null,
    };
  }
}
```

**Convenções:**
- `camelCase` para variáveis e funções; `PascalCase` para classes e interfaces
- Arquivos nomeados igual à classe principal que exportam
- Sem magic strings — constantes em `src/config/index.ts`
- Logs via `logger.info/warn/error` — nunca `console.log` em produção
- Imports absolutos configurados via `tsconfig.json` (`paths`)

---

## Estratégia de Crawling (§5.4 — Escalabilidade, §6.3 — Robustez, §9)

### Pipeline de Execução

```
CSV Input (UrlSource)  →  parse-ifood-url (puro)  →  group-by-merchant
   │
   ▼
 crawl-products-use-case
   │
   ▼
 url-queue (Semaphore, N workers) ----[checkpoint a cada 25]----> file-checkpoint-store
   │
   ├─[worker 1]─→ browser-pool → playwright-fetcher → ifood-api-extractor → composite-result-sink
   ├─[worker 2]─→   (intercepta API)          ↓ fallback                       │
   └─[worker N]─→                          ifood-dom-extractor                 │
                                                                               ▼
                                           [json + csv + xlsx sinks]
                                                                               │
                                                                               ▼
                                                                   metrics-collector
                                                                   (p50/p95/p99, throughput)
```

### Política de Retry com Backoff Exponencial + Jitter (§9)

```
Tentativa 1 → falha → aguarda  1s ± 250ms
Tentativa 2 → falha → aguarda  2s ± 500ms
Tentativa 3 → falha → aguarda  4s ± 1s
Tentativa 4 → marca como error definitivo, registra categoria, segue
```

- **Retry apenas para erros transitórios:** TIMEOUT, NETWORK_ERROR, HTTP 5xx, BLOCKED.
- **Sem retry para erros permanentes:** HTTP 404, INVALID_URL, PARSE_FAILURE (logado direto).
- **Timeout por URL:** 30s padrão (env `TIMEOUT_MS`)
- **Concorrência padrão:** 8 workers (env `CONCURRENCY`) com 2-3 browsers compartilhados via BrowserContext
- **Rate limiting cortês:** delay aleatório 500-1500ms entre requests por worker (env `DELAY_MIN_MS`/`DELAY_MAX_MS`)
- **Checkpoint:** flush incremental a cada 25 URLs em `checkpoint/progress.json` → `--resume` salta já processadas
- **Circuit breaker:** se 20 falhas BLOCKED consecutivas → pausa de 60s + log de alerta

### Estratégia Anti-Bot e Anti-Flakiness (§6.3, §14)

O iFood usa Cloudflare e detecção JS. Camadas defensivas, da mais barata para a mais cara:

1. **User-agent real** — Chrome 124 atualizado, não `HeadlessChrome`
2. **Viewport humano** — 1366x768, não o default do headless
3. **Headers Accept-Language pt-BR** — condizente com o domínio brasileiro
4. **Locale + timezone** — `pt-BR` / `America/Sao_Paulo`
5. **Stealth mínimo** — sobrescrever `navigator.webdriver = undefined` via init script
6. **API interception (estratégia primária)** — capturar `**/marketplace.ifood.com.br/v*/items/**` via `page.route()`;
   se a API retornar JSON do produto, extrair direto (sem depender de DOM)
7. **Fallback DOM** — se a API não for capturada em 8s, ler `<script id="__NEXT_DATA__">` ou seletores CSS
8. **Backoff em BLOCKED** — ao detectar HTTP 429 ou CAPTCHA, pausar worker por 30s antes do retry

**Seletores-alvo do fallback DOM** (validar no Task B3 antes de codar):
```
Title:           h1[data-testid="item-title"]  |  h1.item-detail__title
Normal price:    [data-testid="item-price"]   |  .price__value-original
Discount price:  [data-testid="item-price-discount"] | .price__value-promotional
Image:           img[data-testid="item-image"] | .item-detail__image img
Next.js JSON:    script#__NEXT_DATA__ → props.pageProps.item
```

### Uso de Memória e Browser Pool

- **Pool fixo de 2-3 browsers Chromium** compartilhados entre todos os workers
- Cada worker pega um `BrowserContext` isolado (cookies/storage separados, baixo overhead)
- Contexto descartado após cada URL para evitar leak de memória acumulada
- Browsers reciclados a cada 100 URLs (defensive restart)
- Alvo: pico de memória < 1.5GB durante execução das 1.000 URLs

### Otimização: Agrupamento por Merchant (KISS)

O CSV real contém URLs do mesmo merchant repetidas (mesmo merchant-uuid no path). Estratégia:

1. **Parse antecipado** — `parse-ifood-url.ts` (puro, sem I/O) extrai `merchantId`/`itemId` de cada URL.
2. **Agrupamento** — `group-by-merchant.ts` organiza URLs em buckets `Map<merchantId, url[]>`.
3. **Reúso de BrowserContext** — workers consomem buckets inteiros: 1 context warm-up (cookies Cloudflare,
   localStorage) é amortizado entre N itens do mesmo merchant → menos challenges de bot, menos latência.
4. **Distribuição** — buckets são distribuídos round-robin entre workers para manter paralelismo.
5. **Fallback** — se 1 merchant tiver >50 items, é dividido em sub-buckets para não monopolizar 1 worker.

**Ganho esperado:** redução de ~20-30% de tempo total em datasets onde >40% das URLs compartilham merchant
(perfil do CSV de exemplo: ~600 merchants únicos em 999 URLs → ~40% de URLs em merchants repetidos).

---

## Variáveis de Ambiente (.env.example)

```env
# === I/O ===
INPUT_FILE=input/urls.csv
OUTPUT_DIR=output
# Formatos de saída: lista separada por vírgula. Opções: json,csv,xlsx
OUTPUT_FORMATS=json,csv

# === Concorrência ===
CONCURRENCY=8                # workers paralelos (5-15 recomendado)
BROWSER_POOL_SIZE=3          # browsers compartilhados

# === Resiliência ===
MAX_RETRIES=3                # tentativas por URL antes de marcar error
TIMEOUT_MS=30000             # timeout por página
DELAY_MIN_MS=500             # delay mínimo entre requests por worker
DELAY_MAX_MS=1500            # delay máximo

# === Browser ===
HEADLESS=true                # false apenas para debug visual
USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

# === Checkpoint ===
CHECKPOINT_INTERVAL=25       # salva progresso a cada N URLs

# === Observabilidade ===
LOG_LEVEL=info               # debug | info | warn | error
```

---

## Estratégia de Testes (§6.2, §13 — Diferenciais)

| Nível | Framework | Localização | O que cobre | Meta |
|---|---|---|---|---|
| Unitário | vitest | `tests/unit/domain/` | Product factory, validações, errors | 100% |
| Unitário | vitest | `tests/unit/adapters/input/` | CSV/JSON/TXT/XLSX UrlSources com fixtures | 90% |
| Unitário | vitest | `tests/unit/adapters/extractor/` | IfoodApiExtractor (JSON real capturado) + IfoodDomExtractor (HTML real capturado) | 85% |
| Unitário | vitest | `tests/unit/adapters/storage/` | Todos os sinks com 5 produtos mock | 90% |
| Unitário | vitest | `tests/unit/infrastructure/queue/` | retry, backoff, timeout, circuit breaker | 80% |
| Unitário | vitest | `tests/unit/infrastructure/metrics/` | cálculo de taxa, p50/p95, throughput | 100% |
| Integração | vitest | `tests/integration/` | Pipeline real com 3 URLs do CSV (rede ativa) | smoke |
| Manual | — | execução + evidências | 1.000 URLs com `execution_report.json` | ≥ 95% taxa |

**Meta global de cobertura:** ≥ 80% em `src/domain/`, `src/application/`, `src/adapters/extractor/`,
`src/adapters/input/`, `src/infrastructure/metrics/`.

**Fixtures determinísticas:** capturar 5 respostas reais (HTML + JSON da API) no Task B3,
salvar em `fixtures/`, e usar nos testes — garante que parser quebra alto se iFood mudar
layout, sem depender de rede.

---

## Formato de Saída (§5.3, §4, §7.3, §7.4)

### `products_output.json` — saída canônica
```json
[
  {
    "title": "Combo X-Burger",
    "normal_price": "R$ 39,90",
    "discount_price": "R$ 29,90",
    "product_url": "https://www.ifood.com.br/delivery/...",
    "image_url": "https://static.ifood-static.com.br/...",
    "status": "success",
    "error_message": null
  },
  {
    "title": null,
    "normal_price": null,
    "discount_price": null,
    "product_url": "https://www.ifood.com.br/delivery/...",
    "image_url": null,
    "status": "error",
    "error_message": "Produto indisponível ou removido (404)"
  }
]
```

### `products_output.csv`
```
title,normal_price,discount_price,product_url,image_url,status,error_message
"Combo X-Burger","R$ 39,90","R$ 29,90","https://...","https://...","success",
,,, "https://...",,"error","Produto indisponível ou removido (404)"
```

### `products_output.xlsx` (diferencial §13)
Mesmo schema, 1 aba `products`, com filtros automáticos no header.

### `execution_report.json` — Evidência oficial (§7.3)
```json
{
  "started_at": "2026-05-24T02:00:00.000Z",
  "finished_at": "2026-05-24T02:18:30.000Z",
  "duration_seconds": 1110,
  "total_urls": 1000,
  "successes": 963,
  "failures": 37,
  "success_rate_percent": 96.3,
  "errors_by_category": {
    "NOT_FOUND": 18,
    "TIMEOUT": 9,
    "BLOCKED": 6,
    "PARSE_FAILURE": 3,
    "NETWORK_ERROR": 1,
    "HTTP_ERROR": 0,
    "INVALID_URL": 0,
    "UNKNOWN": 0
  },
  "latency_ms": { "p50": 4200, "p95": 12500, "p99": 24800, "avg": 5230 },
  "throughput_urls_per_minute": 54.0,
  "output_files": [
    "output/products_output.json",
    "output/products_output.csv"
  ],
  "config_snapshot": {
    "concurrency": 8,
    "max_retries": 3,
    "timeout_ms": 30000
  }
}
```

### `execution_summary.md` — Dashboard textual (diferencial §13)
Gerado ao final em Markdown para colar no README/PR:
```markdown
# Crawler iFood — Execução 2026-05-24

| Métrica | Valor |
|---|---|
| URLs processadas | 1.000 |
| Sucessos | 963 (96,3%) |
| Falhas | 37 (3,7%) |
| Duração total | 18m 30s |
| Throughput | 54 URLs/min |
| Latência p50 / p95 | 4,2s / 12,5s |

## Falhas por categoria
- NOT_FOUND: 18 (produto removido)
- TIMEOUT: 9 (servidor lento)
- BLOCKED: 6 (CAPTCHA pontual)
- PARSE_FAILURE: 3 (layout não reconhecido)
- NETWORK_ERROR: 1
```

---

## Boundaries (§9 — Boas Práticas, §10 — Restrições)

**Always (sempre fazer):**
- Registrar todo erro com URL + mensagem + tentativas no log
- Aplicar delay entre requests para não sobrecarregar o servidor
- Salvar checkpoint a cada 50 URLs
- Usar variáveis de ambiente para toda configuração
- Tratar timeout, HTTP error, produto indisponível como `status: 'error'` (nunca crash)

**Ask First (perguntar antes):**
- Aumentar concorrência acima de 20 workers
- Adicionar novas dependências de terceiros
- Mudar a estrutura do arquivo de saída

**Never (nunca fazer):**
- Hardcodar credenciais, caminhos absolutos ou chaves de API
- Usar `process.exit()` para encerrar em caso de erro de URL individual
- Fazer `catch` silencioso sem logar o erro
- Processar URLs de forma exclusivamente sequencial (viola §10)
- Commitar `.env` com valores reais

---

## Critérios de Sucesso (§8 — Critérios de Avaliação)

Mapeamento direto dos pesos do case com critério **testável**:

| Critério do Case | Peso | Verificação |
|---|---|---|
| Funcionamento da solução | 30% | `npm start` processa as 999 URLs sem crash; 3 arquivos de saída gerados; `execution_report.json` válido |
| Taxa de sucesso ≥ 95% | 20% | `jq '.success_rate_percent >= 95' output/execution_report.json` retorna `true` |
| Qualidade e organização do código | 15% | `npm run lint` exit 0; `npm run build` exit 0; estrutura hexagonal (ports/adapters); cobertura ≥ 80% |
| Escalabilidade e performance | 15% | 1.000 URLs em ≤ 25 min com 8 workers; pico de RAM < 1.5GB; sem memory leak |
| Tratamento de erros e resiliência | 10% | 8 categorias de erro mapeadas; retry com backoff funciona em testes; checkpoint permite `--resume` |
| Documentação e evidências | 10% | README cobre 12 tópicos §7.2; `execution_summary.md` + `execution_report.json` + logs/ presentes |

---

## Definition of Done

Para considerar o case ENTREGUE, todos os itens abaixo devem estar `true`:

- [ ] `npm install && npm test` em diretório limpo exit 0
- [ ] `npm start` processa o CSV oficial das 999 URLs sem interven\u00e7\u00e3o humana
- [ ] `output/products_output.json` cont\u00e9m 999 itens; `output/products_output.csv` cont\u00e9m 1000 linhas (header + 999)
- [ ] `output/execution_report.json` reporta `success_rate_percent >= 95`
- [ ] `logs/crawler_*.log` cont\u00e9m logs estruturados JSON da execu\u00e7\u00e3o completa
- [ ] `docker compose up` reproduz a execu\u00e7\u00e3o em ambiente isolado (diferencial \u00a713)
- [ ] `README.md` cobre os 12 t\u00f3picos do \u00a77.2 \u2014 checklist verificado linha a linha
- [ ] 4 ADRs em `docs/adr/` documentando decis\u00f5es-chave
- [ ] Cobertura de testes em `src/domain`, `src/adapters/extractor`, `src/adapters/input` >= 80%
- [ ] `grep -ri "password\|secret\|api_key" src/ tests/` sem resultados
- [ ] `.env` no `.gitignore`; apenas `.env.example` versionado
- [ ] `--resume` funciona: matar processo no meio, religar, completa de onde parou

---

## Cobertura Detalhada dos 14 Parágrafos do Case

| § | Tópico | Onde está implementado | Como verificar |
|---|---|---|---|
| **§1** | Contexto | Seção `Objetivo` + `docs/adr/0001-typescript-playwright.md` + README §1 | Leitura |
| **§2** | Objetivo do Desafio | `crawl-products-use-case` + `metrics-collector` | Execução das 1.000 URLs com `success_rate >= 95%` |
| **§3** | Escopo (6 capacidades) | (1) `UrlSource` adapters · (2) `PlaywrightFetcher` · (3) `IfoodApiExtractor`+`IfoodDomExtractor` · (4) `ResultSink` adapters · (5) `execution_report.json` + logs · (6) `README.md` | Cada capacidade ↔ módulo na árvore |
| **§4** | 7 campos obrigatórios | Interface `Product` em `src/domain/Product.ts` | Validação no `IfoodExtractor`: todas as 7 chaves presentes em 100% dos itens |
| **§5.1** | Linguagem justificada | `docs/adr/0001-typescript-playwright.md` | README §"Tech Stack" + ADR |
| **§5.2** | Input multi-formato | 4 adapters: `CsvUrlSource`, `JsonUrlSource`, `TxtUrlSource`, `XlsxUrlSource` | Testes unitários com 4 fixtures |
| **§5.3** | Output multi-formato | 3 sinks: Json, Csv, Xlsx + Composite | `OUTPUT_FORMATS=json,csv,xlsx` gera 3 arquivos |
| **§5.4** | Escalabilidade (8 quesitos) | concorrência: Semaphore custom · retry: retry-with-backoff custom · timeout: 30s · indisponíveis: error category NOT_FOUND · logs: JSON logger custom · rate-limit: delay aleatório · resume: checkpoint · memória: browser pool fixo | Execução real + métricas |
| **§5.5** | Taxa ≥ 95% | `metrics-collector.calculateRate()` | Campo `success_rate_percent` no report |
| **§6.1** | Código limpo (7 critérios) | Hexagonal · ESLint · módulos pequenos · errors tipados · sem secrets · README detalhado | `npm run lint` + revisão |
| **§6.2** | Arquitetura (diferenciais) | Ports/Adapters · workers via Semaphore · async/paralelo · JSON logger nativo · metrics-collector · .env via Node 24 · vitest | Estrutura de pastas |
| **§6.3** | Robustez (8 cenários) | 8 `CrawlErrorCategory` mapeadas + retry seletivo + parser tolerante a null | Testes unitários cobrindo cada categoria |
| **§6.4** | Documentação (12 itens) | README + `docs/architecture.md` + ADRs | Checklist no README |
| **§7.1** | Código-fonte | Repo Git público | Link |
| **§7.2** | README (12 tópicos) | `README.md` | Checklist explícito no DoD |
| **§7.3** | Evidências | `execution_report.json` + `execution_summary.md` + `logs/crawler_*.log` + screenshot terminal | 4 artefatos no PR |
| **§7.4** | Dados coletados | `products_output.{json,csv,xlsx}` | Arquivo final no repo ou release |
| **§8** | Critérios de avaliação | Tabela acima com verificação para cada peso | Auditoria pelo avaliador |
| **§9** | Boas práticas (8 itens) | Delay aleatório · Semaphore (fila) · retry+backoff · log de falhas · sem hardcode · código simples · circuit breaker | Code review |
| **§10** | Restrições (7 don'ts) | Sem credenciais · totalmente automatizado · sem manual loop · código + docs + evidências entregues · erros logados · reprodutível via README/Docker | Checklist no PR |
| **§11** | Prazo (7 dias) | Cronograma detalhado abaixo | Tracking de tasks |
| **§12** | Formato de envio | Repo Git + README + output/ + logs/ + reprodução | Link no email |
| **§13** | Diferenciais (10/10) | Mapeamento explícito abaixo → todos cobertos | README §"Diferenciais" + seção dedicada |
| **§14** | Observações | Anti-bot (5 camadas) + API interception + DOM fallback + retry tolerante a flakiness + categorias de erro para análise post-mortem | Seção "Estratégia Anti-Bot" |

---

## Diferenciais §6.2 — Arquitetura (6/6)

Cada item de §6.2 do case é entregue por código identificável no repo.

| # | Item §6.2 | Como é entregue | Localização |
|---|---|---|---|
| 1 | **Separação entrada/coleta/parsing/persistência** | Hexagonal: 4 pacotes distintos com ports na fronteira | `adapters/input/`, `adapters/fetcher/`, `adapters/extractor/`, `adapters/storage/` |
| 2 | **Filas ou workers** | `Semaphore` custom (in-memory queue) + N workers paralelos consumindo `UrlBatch` | `application/concurrency/semaphore.ts` + `infrastructure/queue/url-queue.ts` |
| 3 | **Execução assíncrona/paralela** | `async`/`await` ponta-a-ponta + `Promise.allSettled` no fan-out de sinks + workers concorrentes via Semaphore | use case principal + composite sink |
| 4 | **Logs estruturados** | JSON logger custom escrevendo no `process.stdout.write` (1 linha = 1 evento JSON com `ts`, `level`, `msg`, `ctx`) | `infrastructure/logger/index.ts` |
| 5 | **Métricas de execução** | `MetricsCollector` agrega contadores (sucessos/falhas por categoria), histograma de latências (p50/p95/p99) e throughput | `application/metrics/metrics-collector.ts` → `execution_report.json` |
| 6 | **Config via env/arquivo + Testes automatizados** | `--env-file=.env` nativo + `AppConfig` validado em boot + vitest com `tests/unit/` e `tests/integration/` | `infrastructure/config/index.ts` + `tests/` |

---

## Diferenciais §13 — Mapeamento Explícito (10/10)

Cada diferencial é entregue por código identificável no repo. Sem "promessas vagas".

| # | Diferencial | Como é entregue | Evidência |
|---|---|---|---|
| 1 | **Docker** | `Dockerfile` multi-stage (builder + runtime) com Playwright pré-instalado + `docker-compose.yml` para volumes de input/output | `docker compose run crawler` executa fim-a-fim |
| 2 | **Testes automatizados** | vitest com `tests/unit/` + `tests/integration/`; cobertura ≥ 80% no domínio e adapters críticos | `npm run test:coverage` + badge no README |
| 3 | **Pipeline simples de execução** | npm scripts encadeados: `install → playwright:install → start`; um comando único: `npm run pipeline` | README §"Execução" mostra one-liner |
| 4 | **Arquitetura baseada em filas** | `Semaphore` (in-memory queue) custom em `src/application/concurrency/semaphore.ts` + `Queue<UrlBatch>` consumido por N workers paralelos | Diagrama no README + teste unitário de fairness |
| 5 | **Dashboard / relatório resumido** | `execution_summary.md` gerado ao final com tabelas (total, sucessos, falhas, taxa, tempo, top-5 erros, p50/p95) | Artefato `output/execution_summary.md` |
| 6 | **Métricas detalhadas** | Em `execution_report.json`: throughput URLs/min, latência p50/p95/p99, contagem por `CrawlErrorCategory`, distribuição de retries | Schema documentado em SPEC §"Formato de Saída" |
| 7 | **Exportação em múltiplos formatos** | Composite `ResultSink` agrega: `json-result-sink.ts`, `csv-result-sink.ts`, `xlsx-result-sink.ts`; `OUTPUT_FORMATS=json,csv,xlsx` produz 3 arquivos | Teste integração valida 3 outputs |
| 8 | **Retomar execução interrompida** | `checkpoint.json` salvo a cada 25 URLs; flag `--resume` pula URLs já processadas no Crawl atual | Teste: matar processo, retomar, verificar |
| 9 | **Separação crawler/parser/storage** | Arquitetura hexagonal: `domain/` (modelo puro) + `application/` (crawl-products.use-case) + `adapters/fetcher/` (crawler) + `adapters/extractor/` (parser) + `adapters/storage/` (storage) | Estrutura de pastas em `src/` + ADR-0003 |
| 10 | **Cloud-ready** | 12-factor: config via env, logs no stdout (JSON), graceful shutdown via SIGTERM, checkpoint externalizável, Docker rootless, exit codes semânticos (0 sucesso, 1 erro fatal, 2 taxa <95%) | Seção "Cloud Readiness" no README |

---

## Cronograma de 7 Dias (§11)

| Dia | Foco | Tasks | Entregável do dia |
|---|---|---|---|
| **D1** | Fundação + Exploração | A1, A2, A3, A4 + análise manual de 5 URLs do iFood (DevTools) | Scaffold + ADRs 0001/0003 + fixtures capturadas |
| **D2** | Input/Storage/Métricas | A5, A6, A7, A8 | Camada de I/O testada |
| **D3** | Browser + Fetcher | B1, B2 | PlaywrightFetcher capturando API + retry |
| **D4** | Extractor + Queue | B3, B4 + ADR-0002 | Pipeline funcional com 50 URLs reais |
| **D5** | Integração + Execução | C1, C2, C3 + 1ª execução completa | Primeiro `execution_report.json` |
| **D6** | Tuning + Docker + Diferenciais | Ajuste de concorrência, ADR-0004, D1 Docker, polimento XLSX | Taxa ≥ 95% atingida + Docker rodando |
| **D7** | Documentação + Empacotamento | D2 README, D3 segurança, D4 commit final + tag | PR pronto para entrega |

> Buffer de meio dia em D6 para reagir a bloqueios não previstos (CAPTCHA persistente, etc.).

---

## ADRs Previstos (`docs/adr/`) — JÁ CRIADOS

| ID | Título | Status |
|---|---|---|
| **0001** | TypeScript + Playwright em vez de Python + Scrapy | ✅ `docs/adr/0001-typescript-playwright.md` |
| **0002** | API interception como estratégia primária, DOM como fallback | ✅ `docs/adr/0002-api-interception-primary.md` |
| **0003** | Arquitetura hexagonal mesmo sendo script CLI | ✅ `docs/adr/0003-hexagonal-architecture.md` |
| **0004** | Multi-sink Composite em vez de output flag única | ✅ `docs/adr/0004-multi-sink-composite.md` |
| **0005** | Caminho de Escalabilidade — KISS hoje, ports para evolução | ✅ `docs/adr/0005-scalability-path.md` |
| **0006** | Sessão obrigatória com endereço-âncora via profile persistente | ✅ `docs/adr/0006-session-and-persistent-profile.md` |

---

## Roadmap de Escalabilidade (referência: ADR-0005)

> Princípio: a **arquitetura hexagonal** (ADR-0003) já é escalável por design. Não adicionamos
> infra pesada antecipadamente — mas garantimos que toda integração futura seja **drop-in via porta**.

### Triggers de evolução e adapters substitutos

| Eixo | Hoje (1 máquina, ~1k URLs) | Trigger para evoluir | Próxima impl (mesma porta) |
|---|---|---|---|
| **Paralelismo** | `InMemorySemaphoreQueue` (8 workers) | > 100k URLs/run **ou** > 1 worker físico | `BullMqQueue implements JobQueue` |
| **Persistência da fila** | Checkpoint JSON local | Resume entre máquinas | Redis (via BullMQ) |
| **Storage** | `JsonResultSink`, `CsvResultSink`, `XlsxResultSink` | Saída precisa ser consultável/streamable | `PostgresResultSink` ou `S3ResultSink` (mesma porta `ResultSink`) |
| **Input** | `CsvUrlSource` (arquivo) | Submissão sob demanda | `HttpUrlSource` (REST/queue) |
| **Observabilidade** | JSON logs + report local | Múltiplas instâncias | OpenTelemetry exporter (decorator de `MetricsCollector`) |
| **Interface** | CLI (`util.parseArgs`) | Consumidores externos | Fastify + `@fastify/swagger` em `src/adapters/http/` |

### Portas que viabilizam essa evolução (todas em `src/application/ports/`)

| Porta | Implementação hoje | Implementações futuras possíveis |
|---|---|---|
| `UrlSource` | `CsvUrlSource`, `JsonUrlSource`, `TxtUrlSource`, `XlsxUrlSource` | `HttpUrlSource`, `KafkaUrlSource` |
| `PageFetcher` | `PlaywrightFetcher` | `AxiosFetcher`, `CheerioFetcher` (HTTP simples) |
| `ProductExtractor` | `IfoodApiExtractor`, `IfoodDomExtractor` | `IfoodGraphqlExtractor` |
| `ResultSink` | `JsonResultSink`, `CsvResultSink`, `XlsxResultSink`, `CompositeResultSink` | `PostgresResultSink`, `S3ResultSink`, `KafkaResultSink` |
| `CheckpointStore` | `FileCheckpointStore` | `RedisCheckpointStore` |
| `JobQueue` *(nova)* | `InMemorySemaphoreQueue` | `BullMqQueue`, `SqsQueue` |

**Garantia formal:** todo código em `domain/` e `application/` depende **apenas** de portas (interfaces).
Nenhum `import` direto de Playwright/exceljs/fs vaza para o núcleo. Trocar adapter = trocar binding
no composition root (`src/main.ts`), zero refactor.

---

## Open Questions

1. **Seletores DOM:** Confirmar `data-testid` reais inspecionando 5 URLs no D1.
   Mitigação: API interception é primária, DOM é fallback — risco reduzido.
2. **Bloqueio de bot:** Se ≥ 5% das URLs caírem em `BLOCKED`, escalar:
   (a) rotacionar user-agents, (b) reduzir concorrência para 4, (c) aumentar delays para 2-5s.
3. **URLs de lojas "desativadas":** O CSV contém URLs como `desativada-fenix---...`.
   Comportamento esperado: erro `NOT_FOUND` registrado corretamente (sem crash).

---

# PLANO DE IMPLEMENTAÇÃO (Phase 2)

## Componentes e Dependências (Grafo)

```
[infrastructure/config (--env-file nativo + validação inline)]
        │
        ├──→ [infrastructure/logger (JSON custom)]
        │
        ├──→ [domain/* (product, errors, execution-report)]
        │           │
        │           ├──→ [adapters/input/* (4 sources)]
        │           ├──→ [adapters/extractor/* (Api + Dom)]
        │           ├──→ [adapters/storage/* (4 sinks + Composite)]
        │           ├──→ [adapters/checkpoint/FileCheckpointStore]
        │           ├──→ [adapters/fetcher/BrowserPool]
        │           └──→ [adapters/fetcher/PlaywrightFetcher]
        │                       │
        │                       └──→ [infrastructure/queue/UrlQueue (Semaphore+retry-with-backoff)]
        │                                       │
        │                                       └──→ [application/CrawlProductsUseCase]
        │                                                       │
        │                                                       └──→ [main.ts (composition root)]
        │
        └──→ [infrastructure/metrics/metrics-collector] ── injetado em todos
```

## Ordem de Implementação

```
FASE A — Fundação (sem rede, sem browser, 100% testável)
  A1 → Scaffold: tsconfig strict, package.json, vitest.config.ts, ESLint, prettier, .gitignore
  A2 → src/domain/* (Product, errors, value objects)
  A3 → src/infrastructure/config/index.ts (process.env via --env-file + validação inline)
  A4 → src/infrastructure/logger/index.ts (JSON logger custom)
  A5 → src/application/ports/* (6 interfaces)
  A6 → src/adapters/input/* (4 UrlSources)
  A7 → src/infrastructure/metrics/metrics-collector.ts
  A8 → src/adapters/checkpoint/file-checkpoint-store.ts
  A9 → src/adapters/storage/* (Json + Csv + Xlsx + Composite sinks)

FASE B — Crawler (requer browser + URLs reais)
  B0 → scripts/bootstrap-address.ts (automatizado, 1x; gera fixtures/browser-profile/) ⚠ Marco 5
  B1 → scripts/capture-fixtures.ts (5 URLs reais via profile) → fixtures/captures/ + docs/observed-selectors.md
  B2 → src/adapters/fetcher/browser-pool.ts (pool de 2-3 browsers, profile persistente)
  B3 → src/adapters/fetcher/playwright-fetcher.ts (intercept JSON + detecção OUT_OF_DELIVERY_AREA)
  B4 → src/adapters/extractor/ifood-api-extractor.ts (estratégia primária — JSON capturado)
  B5 → src/adapters/extractor/ifood-dom-extractor.ts (fallback — __NEXT_DATA__ tem só metadata; preço só via API)
  B6 → src/infrastructure/queue/url-queue.ts (Semaphore + retry-with-backoff + delay aleatório + circuit breaker)

FASE C — Integração
  C1 → src/application/crawl-products-use-case.ts
  C2 → src/infrastructure/cli/index.ts + src/main.ts (composition root)
  C3 → Testes unitários completos (cobertura ≥ 80% nas camadas críticas)
  C4 → Teste de integração com 3 URLs reais
  C5 → Execução completa das 999 URLs + geração de evidências

FASE D — Entregáveis e diferenciais
  D1 → Docker multi-stage (Dockerfile + docker-compose.yml)
  D2 → .github/workflows/ci.yml (lint + test em PR)
  D3 → docs/architecture.md + 4 ADRs
  D4 → README.md completo (12 tópicos §7.2)
  D5 → Revisão de segurança (grep secrets, .env.example sem valores)
  D6 → Empacotamento final (tag v1.0, release notes)
```

## Riscos e Mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| iFood exige endereço setado (Marco 5) | **Confirmado** | Alto | B0 bootstrap automatizado + profile persistente + categoria OUT_OF_DELIVERY_AREA |
| iFood bloqueia headless (Cloudflare) | Alta | Alto | Chrome real (`channel:'chrome'`) + `playwright-extra` + stealth-plugin + profile aquecido (ADR-0006) |
| Layout muda durante o teste | Média | Alto | Estratégia primária via API (raramente muda) + fallback DOM + 5 fixtures versionadas |
| Memória excedida | Média | Médio | Pool fixo 2-3 browsers + reciclagem a cada 100 URLs + context isolado por URL |
| Taxa < 95% | Baixa-Média | Alto | Retry com backoff + jitter; reduzir concorrência se BLOCKED >5%; usar `--resume` |
| URLs "desativadas" no CSV | Certa | Baixo | Categoria NOT_FOUND tratada como comportamento esperado |
| Tempo de execução >30min | Média | Médio | Tuning de concorrência em D6; throughput meta = 50 URLs/min |
| Playwright não roda no CI | Baixa | Médio | Testes de integração marcados como opt-in via `RUN_INTEGRATION=1` |

---

# TASKS (Phase 3)

## FASE A — Fundação

```markdown
- [x] A1: Scaffold do projeto ✅
  - Acceptance: `npm install` + `npm test` + `npm run build` + `npm run lint` exit 0
  - Verify: vitest 1 passed (placeholder); tsc compila sem erro; eslint sem warnings
  - Files: package.json, tsconfig.json, vitest.config.ts, .eslintrc.cjs, .prettierrc, .gitignore, .env.example, .nvmrc, src/cli/index.ts (stub), tests/unit/placeholder.test.ts

- [ ] A2: Domain layer
  - Acceptance: Product, CrawlResult, ExecutionReport, CrawlErrorCategory exportados; sem deps externas
  - Verify: `npm run build`; testes unitários do domain passam; nenhum `import` de adapters/infrastructure
  - Files: src/domain/product.ts, src/domain/errors.ts, src/domain/crawl-result.ts, src/domain/execution-report.ts

- [x] A3: Config ✅
  - Acceptance: Lê process.env (populado por `--env-file=.env`); valida vars obrigatórias com função simples; exporta AppConfig tipado
  - Verify: Teste: .env sem CONCURRENCY → erro claro; .env completo → AppConfig válido
  - Files: src/infrastructure/config/index.ts, tests/unit/infrastructure/config.test.ts

- [x] A4: Logger (JSON custom nativo) ✅
  - Acceptance: JSON em produção via `process.stdout.write`; modo pretty em dev (NODE_ENV=development) com cores ANSI; níveis info/warn/error/debug; campos timestamp/level/msg/...rest
  - Verify: Importar logger e logar → arquivo criado em logs/ com JSON válido por linha
  - Files: src/infrastructure/logger/index.ts

- [x] A5: Ports (interfaces) ✅
  - Acceptance: 6 interfaces (UrlSource, PageFetcher, ProductExtractor, ResultSink, CheckpointStore, JobQueue) exportadas
  - Verify: `tsc --noEmit` compila; nenhuma implementação ainda
  - Files: src/application/ports/*.ts

- [x] A6: UrlSources (4 adapters) ✅
  - Acceptance: CsvUrlSource lê o arquivo oficial de 999 URLs; Json/Txt/Xlsx leem suas fixtures; todas retornam string[]
  - Verify: 4 testes unitários com fixtures; teste com CSV oficial: 999 URLs carregadas
  - Files: src/adapters/input/*.ts, tests/unit/adapters/input/*.test.ts, fixtures/urls.{json,txt,xlsx}

- [x] A7: metrics-collector ✅
  - Acceptance: Tracks total/success/failure por categoria; calcula p50/p95/p99 (via array sort, sem dep); throughput
  - Verify: Teste: 950 success + 50 NOT_FOUND → rate=95.0; report.errors_by_category.NOT_FOUND=50
  - Files: src/infrastructure/metrics/metrics-collector.ts, tests/unit/infrastructure/metrics/*.test.ts

- [x] A8: FileCheckpointStore ✅
  - Acceptance: Salva Set<url> em JSON; carrega no startup; método `filter(urls)` retorna não-processadas
  - Verify: Teste: salvar 50 URLs, ler, filtrar lista de 100 → retorna 50 restantes
  - Files: src/adapters/checkpoint/file-checkpoint-store.ts, tests/unit/adapters/checkpoint/*.test.ts

- [x] A9: ResultSinks (4 + Composite) ✅
  - Acceptance: Json/Csv/Xlsx gravam 5 produtos mock corretamente; Composite escreve em paralelo nos N habilitados
  - Verify: Testes: ler cada arquivo gerado e comparar com fixture
  - Files: src/adapters/storage/*.ts, tests/unit/adapters/storage/*.test.ts
```

## FASE B — Crawler

```markdown
- [ ] B0: Bootstrap automatizado de sessão (PRÉ-REQUISITO ABSOLUTO — descoberta Marco 5)
  - Pré-requisito de host: Google Chrome instalado (`brew install --cask google-chrome`)
  - Acceptance: Script abre Chrome real (`channel:'chrome'`) com `playwright-extra` +
    stealth-plugin em modo persistente; digita endereço-âncora (env `ANCHOR_ADDRESS`,
    default Av Paulista 1000, SP); seleciona primeira sugestão do autocomplete; clica
    "Confirmar localização" no modal de mapa (se aparecer); fixtures/browser-profile/ contém
    cookies+localStorage+cache; fixtures/storage-state.json exportado como backup
  - Idempotência (Marco 5e): rodar o script com profile já aquecido detecta nav renderizada
    (link "Mercados"/"Restaurantes") e pula direto para export — zero ação no DOM
  - Verify: `ls fixtures/browser-profile/Default/Cookies` existe; profile carrega no iFood
    sem mostrar modal "Escolha um endereço"; rodar `npx tsx scripts/bootstrap-address.ts`
    duas vezes seguidas conclui ambas em < 90s sem interação
  - Files: scripts/bootstrap-address.ts, scripts/_browser.ts (stealth helper compartilhado)
  - Riscos cobertos: Cloudflare challenge (Chrome real + stealth-plugin), modal de endereço
    (automação do fluxo), fingerprint de automação (CDP leaks), execução repetida (idempotência)

- [ ] B1: Captura de fixtures reais (depende de B0)
  - Acceptance: 5 URLs do CSV abertas via profile persistente; capturar (a) HTML pós-hydration,
    (b) TODAS as respostas JSON do domínio `*.ifood.com.br/*` (exceto trackers), (c) screenshot;
    aguardar `R$\s*\d` visível antes de capturar
  - Verify: 5 arquivos `ifood-product-NNN.{html,api.json,png}` em fixtures/captures/;
    `docs/observed-selectors.md` documenta o endpoint real que retorna preço,
    o caminho do JSON (ex: `data.menu.items[].price`) e o conteúdo de `__NEXT_DATA__`
  - Files: scripts/capture-fixtures.ts, fixtures/captures/*, docs/observed-selectors.md

- [ ] B2: BrowserPool (revisado para profile persistente)
  - Acceptance: Pool de 2-3 instâncias do Chromium via `launchPersistentContext` apontando
    para `fixtures/browser-profile/` (ou clones isolados, ver nota); `acquire()` retorna page
    pronta em contexto endurecido; `release()` fecha a page; `shutdown()` libera tudo
  - Nota: o profile é compartilhado em modo read-only entre workers. Se Chromium reclamar
    de lock em `SingletonLock`, cada worker recebe uma cópia do profile em `tmp/profile-NN/`
    criada no startup; isso preserva cookies+localStorage por worker sem corromper o original.
  - Verify: Pool de 3, 20 acquires/releases sequenciais, RSS estável (<500MB combinado),
    todos os contextos passam pelo iFood sem mostrar modal de endereço
  - Files: src/adapters/fetcher/browser-pool.ts

- [ ] B3: PlaywrightFetcher (revisado)
  - Acceptance: Navega para URL via context endurecido; aplica 5 camadas anti-bot (já no helper);
    intercepta TODAS as respostas JSON do iFood via `page.on('response')`;
    aguarda preço visível (`R$\s*\d`) com timeout configurável;
    detecta `OUT_OF_DELIVERY_AREA` quando modal "não entrega aqui" aparece;
    retorna `{html, apiJson?, httpStatus, durationMs, deliveryAreaOk}`
  - Verify: Teste integração com URL real do CSV → apiJson com preço preenchido;
    teste com URL de loja distante → deliveryAreaOk=false sem crash
  - Files: src/adapters/fetcher/playwright-fetcher.ts

- [ ] B4: IfoodApiExtractor (PRIMÁRIO)
  - Acceptance: Recebe apiJson do Fetcher; mapeia para Product (7 campos); retorna null se schema não bate
  - Verify: Teste com JSON capturado em B1 (5 fixtures) → todos extraem title corretamente
  - Files: src/adapters/extractor/ifood-api-extractor.ts, tests/unit/adapters/extractor/*.test.ts

- [ ] B5: IfoodDomExtractor (FALLBACK)
  - Acceptance: Parseia HTML via cheerio; tenta __NEXT_DATA__ primeiro, depois seletores CSS; retorna Product ou erro PARSE_FAILURE
  - Verify: Teste com 5 HTMLs capturados; mesmo título extraído via API ou DOM
  - Files: src/adapters/extractor/ifood-dom-extractor.ts

- [ ] B6: UrlQueue
  - Acceptance: Processa N URLs com Semaphore custom; retry seletivo (TIMEOUT/NETWORK/BLOCKED/5xx) com retry-with-backoff; delay aleatório; circuit breaker em 20 BLOCKED consecutivos; emite progresso
  - Verify: Teste com 30 URLs mock, 5 falhando: retry funciona, 30 processadas, concurrency nunca >N, circuit breaker dispara
  - Files: src/infrastructure/queue/url-queue.ts, tests/unit/infrastructure/queue/*.test.ts
```

## FASE C — Integração

```markdown
- [ ] C1: crawl-products-use-case
  - Acceptance: Recebe ports via construtor; orquestra leitura → checkpoint filter → fila → fetch → extract (primário→fallback) → sink → metrics; retorna ExecutionReport
  - Verify: Teste com 10 URLs mock + ports mockados; ExecutionReport tem 10 itens, taxa correta
  - Files: src/application/crawl-products-use-case.ts, tests/unit/application/*.test.ts

- [ ] C2: CLI + main.ts (composition root)
  - Acceptance: `util.parseArgs` parseia --input, --output, --concurrency, --resume, --formats; main.ts monta o grafo e invoca o use case
  - Verify: `npm start -- --input fixtures/urls-3.csv --concurrency 2` completa em <60s com 3 produtos
  - Files: src/infrastructure/cli/index.ts, src/main.ts

- [ ] C3: Testes unitários completos
  - Acceptance: Cobertura ≥ 80% em domain/, adapters/extractor/, adapters/input/, infrastructure/metrics/
  - Verify: `npm run test:coverage` reporta acima das metas
  - Files: tests/unit/**

- [ ] C4: Teste de integração
  - Acceptance: Pipeline real com 3 URLs do CSV; gated por env RUN_INTEGRATION=1; success_rate=100% nessas 3
  - Verify: `RUN_INTEGRATION=1 npm run test:integration` passa
  - Files: tests/integration/crawl-3-urls.test.ts

- [ ] C5: Execução completa + evidências
  - Acceptance: 999 URLs processadas; success_rate ≥ 95%; 6 arquivos gerados em output/ + logs/crawler_*.log
  - Verify: `cat output/execution_report.json | jq .success_rate_percent` ≥ 95; `wc -l output/products_output.csv` = 1000
  - Files: output/products_output.{json,csv,xlsx}, output/execution_report.json, output/execution_summary.md, logs/
```

## FASE D — Entregáveis e Diferenciais

```markdown
- [ ] D1: Docker multi-stage
  - Acceptance: `docker compose up` executa o crawler em ambiente isolado; volume mounta input/ e output/
  - Verify: Em máquina sem Node local: build → up → output gerado idêntico
  - Files: docker/Dockerfile, docker/docker-compose.yml, .dockerignore

- [ ] D2: CI (GitHub Actions)
  - Acceptance: Workflow roda lint + build + test em PR; usa Node 20
  - Verify: Workflow aparece como check no PR
  - Files: .github/workflows/ci.yml

- [ ] D3: Architecture docs + ADRs
  - Acceptance: docs/architecture.md com diagrama mermaid; 4 ADRs preenchidos
  - Verify: Cada ADR segue ADR-FORMAT.md (Context, Decision, Consequences)
  - Files: docs/architecture.md, docs/adr/000{1-4}-*.md

- [ ] D4: README.md (§7.2 — 12 tópicos OBRIGATÓRIOS)
  - Acceptance: Todos os 12 itens cobertos: Descrição · Pré-requisitos · Instalação · Configuração ·
    Execução · Exemplo entrada · Exemplo saída · Estratégia · Tratamento de erros · Evidências ·
    Taxa de sucesso obtida · Tempo de execução · Melhorias futuras
  - Verify: Checklist no PR, item a item
  - Files: README.md

- [ ] D5: Revisão de segurança e boas práticas
  - Acceptance: grep não acha "password|secret|token|api_key" em src/; .env no .gitignore; nenhum URL hardcoded fora de fixtures
  - Verify: `grep -riE 'password|secret|token|api_key' src/ tests/ docker/` retorna vazio
  - Files: .gitignore, todos os src/**

- [ ] D6: Empacotamento e entrega
  - Acceptance: Clone limpo + `npm ci && npx playwright install chromium && npm start` funciona ponta-a-ponta
  - Verify: Em diretório temporário: clone → install → start → output gerado; tag v1.0 criada
  - Files: README.md, CHANGELOG.md (opcional)
```

---

## Estimativa de Tempo (cronograma detalhado em §11)

| Fase | Tasks | Estimativa |
|---|---|---|
| A — Fundação | A1–A9 | ~1.5 dias |
| B — Crawler | B1–B6 | ~2 dias |
| C — Integração | C1–C5 | ~1.5 dias |
| D — Entregáveis | D1–D6 | ~1 dia |
| Buffer/imprevistos | — | ~1 dia |
| **Total** | **26 tasks** | **~7 dias** (dentro do prazo do §11) |

---

## Verificação Final da Spec

Antes de avançar para implementação (Phase 4), confirme:

- [x] Spec cobre as 6 áreas core (objetivo, stack, comandos, estrutura, code style, testes)
- [x] Todos os 14 parágrafos do case.md mapeados explicitamente (tabela §"Cobertura Detalhada")
- [x] Definition of Done com 12 itens binários e verificáveis
- [x] Boundaries (Always/Ask First/Never) definidas
- [x] 4 ADRs identificados com trade-offs reais
- [x] Riscos com mitigações concretas
- [x] Cronograma cabe em 7 dias com buffer
- [ ] **Human review:** confirmar ASSUMPTIONS antes de codar

---

*Esta spec é um documento vivo. Atualize antes de mudar arquitetura ou escopo (skill `grill-with-docs`).*
