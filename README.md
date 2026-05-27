# Crawler de Produtos iFood

Extrai título, preços (normal e com desconto), URL e imagem de até 999 produtos do iFood via interceptação da API interna — contornando automaticamente o PX HUMAN Security (PerimeterX) e o Cloudflare.

---

## Quick Start

### 1 — Setup (uma vez)

```bash
git clone https://github.com/alvaroaxsmith/quickstart-crawler.git
cd quickstart-crawler
npm run setup
```

> `npm run setup` = `npm install` + `npm run build`

### 2 — Gerar dados base (uma vez, se `data/products_output.json` não existir)

A pipeline lê um JSON base com as URLs e faz split em grupos. Se o arquivo não existir, gere-o a partir do CSV:

```bash
node -e "
const fs=require('fs');
const lines=fs.readFileSync('input/urls.csv','utf8').trim().split(/\r?\n/);
lines.shift(); // header
const out=lines.filter(Boolean).map(u=>({product_url:u.trim(),title:''}));
fs.writeFileSync('data/products_output.json',JSON.stringify(out,null,2));
console.log('OK',out.length,'URLs');
"
```

> A primeira execução cria automaticamente `data/groups/urls-{pao,carrefour,farmacia,all}.json` a partir desse JSON. Se já houver grupos preenchidos, são preservados (use `npm run crawl:reset` para regerá-los).

### 3 — Abrir Chrome com CDP (terminal separado, manter aberto)

```bash
npm run chrome
```

> Isso abre o Google Chrome com porta CDP na `9222` apontando para o profile persistente (`fixtures/browser-profile/`) que já contém os cookies `cf_clearance` e `_px3` necessários. **Não feche este terminal durante o crawl.**

### 4 — Executar pipeline completa

```bash
# Do zero (limpa cache + processa todos os 999 produtos)
npm run crawl:reset

# Ou retomando de onde parou (resume automático)
npm run crawl
```

A pipeline processa os grupos em sequência (Pão de Açúcar → Carrefour → Farmácias), salva logs individuais em `docs/evidence/` e gera o relatório final automaticamente.

---

## Outros Comandos

```bash
# Processar um grupo específico
npm run crawl -- --group pao
npm run crawl -- --group carrefour
npm run crawl -- --group farmacia

# Ajustar concorrência (default: 3 workers)
npm run crawl -- --concurrency 4

# Re-tentar apenas os itens que falharam
npm run crawl:retry

# Gerar relatório manualmente
npm run report

# Testes
npm test
```

---

## Saída

Após a execução, os arquivos ficam em:

| Arquivo | Descrição |
|---|---|
| [data/products_output.json](data/products_output.json) | Base de entrada: URLs + título inicial (sem preço) |
| [data/products_output_enriched.json](data/products_output_enriched.json) | Saída principal: 999 produtos com título, preços e status |
| [data/products_output_enriched.csv](data/products_output_enriched.csv) | Mesma saída em CSV (Excel-friendly) |
| [docs/evidence/report.md](docs/evidence/report.md) | Dashboard com métricas (human-readable) |
| [docs/evidence/summary.json](docs/evidence/summary.json) | Métricas estruturadas (machine-readable) |
| [docs/evidence/batch-pao.log](docs/evidence/batch-pao.log) | Log do grupo Pão de Açúcar |
| [docs/evidence/batch-carrefour.log](docs/evidence/batch-carrefour.log) | Log do Carrefour |
| [docs/evidence/batch-farmacia.log](docs/evidence/batch-farmacia.log) | Log das Farmácias |

> Todos os arquivos em `docs/evidence/` são versionados — refletem sempre a última execução completa.

### Formato do JSON de saída

```json
[
  {
    "title": "Desengordurante Spray Veja Cozinha Limão 500ml",
    "normal_price": "R$ 31,99",
    "discount_price": null,
    "product_url": "https://www.ifood.com.br/delivery/brasilia-df/pao-de-acucar-.../5938ca36...?item=c2296a33...",
    "image_url": "https://static-images.ifood.com.br/image/upload/t_high/pratos/820af392.../xyz.jpg",
    "status": "success",
    "error_message": null
  },
  {
    "title": "Produto Indisponível",
    "normal_price": null,
    "discount_price": null,
    "product_url": "https://www.ifood.com.br/...",
    "image_url": null,
    "status": "error",
    "error_message": "Preço não encontrado"
  }
]
```

---

## Grupos de Produtos

| Grupo | Lojas | URLs | Sucesso | Taxa |
|---|---|---|---|---|
| `pao` | Pão de Açúcar | 215 | 178 | 82.8% |
| `carrefour` | Carrefour | 368 | 228 | 62.0% |
| `farmacia` | Farmácias diversas | 363 | 235 | 64.7% |
| `outros` | Não classificados | 53 | 0 | 0.0% |
| **Total** | | **999** | **641** | **64.2%** |

Os arquivos de grupo são gerados automaticamente pela pipeline a partir de `data/products_output.json` (veja passo 2 do Quick Start). Para forçar a regeração:

```bash
npm run crawl:reset
```

---

## Como Funciona

O iFood usa duas camadas de proteção:

| Camada | Tecnologia | Cookie |
|---|---|---|
| TLS Fingerprinting | Cloudflare | `cf_clearance` |
| Bot Detection | PX HUMAN Security | `_px3` |

**Fluxo por produto:**

```
1. Worker navega para a URL do produto (page.goto)
2. React dispara XHR para /site-api/v1/merchants/.../items/...
3. page.on('response') intercepta a resposta JSON → extrai preço
4. Se 403 (PX bloqueio):
   └── resolve "press and hold" 12s (mutex: 1 worker por vez)
   └── fetch imediato após solve (janela de ~400ms)
5. Salva resultado no cache incremental (/tmp/px-batch-results.json)
```

**Retry automático:** ao final de cada grupo, itens com falha são re-enfileirados em rodada-2.

**Resume:** itens já no cache são pulados — interrupções não perdem progresso.

---

## Configuração (opcional)

Padrões funcionais out-of-the-box. Para sobrescrever, crie `.env`:

```env
CDP_URL=http://127.0.0.1:9222
ORIGINAL=data/products_output.json
OUTPUT_FILE=data/products_output_enriched.json
RESULTS_FILE=/tmp/px-batch-results.json
FAILED_FILE=/tmp/px-batch-failed.json
```

A concorrência padrão é **3 workers**. Valores de 3–5 são recomendados.

---

## Pré-requisitos

- **Node.js ≥ 24** (testado com v25)
- **Google Chrome** em `/Applications/Google Chrome.app/` (macOS)
- Profile `fixtures/browser-profile/` com sessão iFood ativa

> **Por que Chrome real?** O Chromium open-source tem TLS fingerprint diferente do Chrome e é detectado pelo Cloudflare. O profile persistente já carrega os cookies `cf_clearance` e `_px3` válidos.

---

## Tratamento de Erros

| Cenário | Comportamento |
|---|---|
| `403` (PX bloqueio) | Aciona solve do challenge → retry imediato |
| `200` sem dados | Produto indisponível — `status: "error"` no output |
| Timeout de navegação | Catch silencioso, avança para o próximo item |
| Context destroyed | Chrome recarregou durante fetch — retry na rodada-2 |
| URL inválida | Item pulado sem crash |
| Falha persistente | Salvo em `/tmp/px-batch-failed.json` |

---

## Taxa de Sucesso

A taxa de sucesso é calculada e publicada pelo relatório:

```
Taxa = produtos com normal_price preenchido / total de URLs
```

Após a execução, consulte:

- [docs/evidence/report.md](docs/evidence/report.md) — dashboard human-readable
- [docs/evidence/summary.json](docs/evidence/summary.json) — métricas estruturadas
- `npm run report` — gera/atualiza os dois acima

Para reprocessar apenas os itens que falharam:

```bash
npm run crawl:retry
```

### Resultados da Execução (2026-05-27)

| Métrica | Valor |
|---|---|
| Total de URLs | **999** |
| Produtos com preço | **641** |
| Falhas | **358** |
| **Taxa de sucesso** | **64.2%** |
| Meta ≥ 95% | ❌ Não atingida |
| Tempo total | 896m 33s |
| Preço mínimo | R$ 4,63 |
| Preço máximo | R$ 301,99 |
| Preço médio | R$ 35,16 |

> As 358 falhas são majoritariamente itens `OUT_OF_DELIVERY_AREA` — lojas fora da área de entrega do endereço-âncora configurado no profile. Ver limitação 5 abaixo.

---

## Limitações Conhecidas

1. **Requer Chrome headful local** — Cookies vinculados ao fingerprint TLS. Não funciona em Docker headless.
2. **Throughput limitado pelo PX solve** — ~12s por solve. Com 3 workers: ~8–12 itens/minuto.
3. **Mouse exclusivo** — O solve PX usa o mouse físico. Não rodar duas instâncias em paralelo.
4. **Sessão expira (~30 min)** — Se `cf_clearance` expirar, basta reabrir Chrome com `npm run chrome`.
5. **Cobertura por endereço-âncora** — Lojas fora da área de entrega do endereço setado no profile não retornam preço (categorizadas como `OUT_OF_DELIVERY_AREA`).

---

## Troubleshooting

**`SyntaxError: Unexpected string` / `Unexpected token ':'` em `scripts/*.mjs`**

O formatador do VS Code pode transformar `??` em `?. ` e ternários `?` em `?.` nos arquivos `.mjs`. Para corrigir em massa:

```bash
perl -i -pe 's/\?\. /?? /g' scripts/*.mjs scripts/lib/*.mjs
```

Depois, inspecione ternários remanescentes (`expr ?.X : Y` → `expr ? X : Y`) com:

```bash
grep -nE '\?\.[^a-zA-Z_$\(\[]' scripts/*.mjs scripts/lib/*.mjs
node --check scripts/run-all.mjs
```

**Para prevenir reincidência:** adicione `scripts/**/*.mjs` ao `.prettierignore` e desabilite "Format on Save" para esses arquivos no VS Code.

**Profile expirou (`cf_clearance: ❌` no warm-up)**

1. Encerre o processo aberto via `npm run chrome` (Ctrl+C no terminal dele).
2. Reabra com `npm run chrome`.
3. Navegue manualmente para https://www.ifood.com.br e resolva o Cloudflare/login até a home carregar normalmente.
4. Retome `npm run crawl` — o resume automático pula o que já foi processado.

**`❌ data/products_output.json não encontrado`**

Rode o snippet do passo 2 do Quick Start.

**Pipeline trava em "Verificando Chrome CDP"**

Verifique se a porta 9222 está acessível: `curl http://127.0.0.1:9222/json/version`. Se não responder, o Chrome com CDP não está rodando — execute `npm run chrome` em outro terminal.

---

## Melhorias Futuras

- **CAPTCHA solver pago como fallback automático** — integrar [CapSolver](https://capsolver.com) ou [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) (ADRs [0009](docs/adr/0009-capsolver-cloudflare-challenge.md) e [0010](docs/adr/0010-flaresolverr-free-alternative.md)) para remover dependência do solve manual via mouse físico e permitir paralelismo real entre máquinas.
- **Proxy residencial rotativo** — distribuir o tráfego entre múltiplos IPs/sessões reduziria a frequência dos challenges PX (ver [ADR-0008](docs/adr/0008-residential-proxy.md)).
- **Docker compose** — o case considera diferencial. Hoje a dependência de Chrome real + mouse no host impede containerização direta; uma alternativa seria um container com VNC + xdotool ou usar o solver pago acima para virar headless-friendly.
- **Persistência em banco** — substituir os JSONs por SQLite/Postgres facilitaria queries e dashboards. A camada `ResultSink` já é uma porta hexagonal — basta um novo adapter.
- **Observabilidade** — exportar métricas em formato Prometheus / OpenTelemetry; hoje as métricas vivem só no `summary.json`.
- **Testes de integração com fixtures HTTP** — os 113 testes unitários cobrem domínio e adapters isolados; falta uma suíte que exercite a pipeline ponta-a-ponta com respostas iFood mockadas (sem depender de Chrome).
- **CI** — pipeline GitHub Actions executando build + testes + lint a cada PR.
- **Endereço-âncora configurável por execução** — permitir lista de endereços para cobrir lojas em regiões diferentes em uma única run.
- **Retomada distribuída** — hoje o cache fica em `/tmp/px-batch-results.json` (local); migrar para Redis ou similar permitiria múltiplas máquinas dividindo o lote.

---

## Estrutura do Código

```
src/
  domain/                   ← tipos e regras de negócio (sem deps externas)
  application/ports/        ← interfaces (contratos)
  application/use-cases/    ← orquestração
  adapters/                 ← Playwright, CSV, JSON, XLSX, checkpoint
  infrastructure/           ← concorrência, métricas, logger, config
  cli/index.ts              ← entry point CLI (npm start)

scripts/
  run-all.mjs               ← pipeline completa (npm run crawl)
  px-batch-parallel.mjs     ← crawler paralelo por grupo
  generate-report.mjs       ← dashboard de métricas (npm run report)
  lib/                      ← utilitários compartilhados

data/
  products_output.json      ← base (título + URL + imagem, sem preço)
  products_output_enriched.json  ← saída final (com preços)
  groups/                   ← URLs segmentadas por loja

tests/unit/                 ← 113 testes unitários (Vitest)
docs/evidence/              ← logs e relatórios de execução
```
