# Crawler de Produtos iFood

Extrai título, preços (normal e com desconto), URL e imagem de até 999 produtos do iFood via interceptação da API interna — contornando automaticamente o PX HUMAN Security (PerimeterX) e o Cloudflare.

---

## Quick Start

### 1 — Setup (uma vez)

```bash
git clone <url-do-repositorio>
cd crawler-test-v2
npm run setup
```

> `npm run setup` = `npm install` + `npm run build`

### 2 — Abrir Chrome com CDP (terminal separado, manter aberto)

```bash
npm run chrome
```

> Isso abre o Google Chrome com porta CDP na `9222` apontando para o profile persistente (`fixtures/browser-profile/`) que já contém os cookies `cf_clearance` e `_px3` necessários.

### 3 — Executar pipeline completa

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

```
data/
  products_output_enriched.json   ← dados completos (999 produtos)
  products_output_enriched.csv    ← mesmos dados em CSV
docs/evidence/
  report.md                       ← dashboard com métricas (human-readable)
  summary.json                    ← métricas estruturadas (machine-readable)
  batch-pao.log                   ← log do grupo Pão de Açúcar
  batch-carrefour.log             ← log do Carrefour
  batch-farmacia.log              ← log das Farmácias
```

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

| Grupo | Lojas | URLs |
|---|---|---|
| `pao` | Pão de Açúcar | 215 |
| `carrefour` | Carrefour | 421 |
| `farmacia` | Farmácias diversas | 363 |
| **Total** | | **999** |

Os arquivos de grupo já estão em `data/groups/`. Para regerá-los a partir de `input/urls.csv`:

```bash
node scripts/px-batch-crawl.mjs --prepare-only
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

```
Taxa = produtos com normal_price preenchido / total de URLs
```

- Pão de Açúcar e Farmácias: próximos de **100%**
- Carrefour: **~85–90%** (alguns merchants têm PX mais rigoroso)
- **Meta geral: ≥ 95%**

Para maximizar a taxa do Carrefour após a execução principal:

```bash
npm run crawl:retry
```

---

## Limitações Conhecidas

1. **Requer Chrome headful local** — Cookies vinculados ao fingerprint TLS. Não funciona em Docker headless.
2. **Throughput limitado pelo PX solve** — ~12s por solve. Com 3 workers: ~8–12 itens/minuto.
3. **Mouse exclusivo** — O solve PX usa o mouse físico. Não rodar duas instâncias em paralelo.
4. **Sessão expira (~30 min)** — Se `cf_clearance` expirar, basta reabrir Chrome com `npm run chrome`.

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
