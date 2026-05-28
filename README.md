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
npm run crawl -- --concurrency 3

# Re-tentar apenas os itens que falharam
npm run crawl:retry

# Renovar cf_clearance via FlareSolverr (requer Docker)
npm run cf:renew

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
    "image_url": null,
    "status": "success",
    "error_message": null
  },
  {
    "title": null,
    "normal_price": null,
    "discount_price": null,
    "product_url": "https://www.ifood.com.br/...",
    "image_url": null,
    "status": "error",
    "error_message": "DEACTIVATED: loja desativada no iFood (URL inativa)"
  },
  {
    "title": null,
    "normal_price": null,
    "discount_price": null,
    "product_url": "https://www.ifood.com.br/...",
    "image_url": null,
    "status": "error",
    "error_message": "UNAVAILABLE: produto indisponível (fora da área de entrega ou bloqueio temporário)"
  }
]
```

> **Nota sobre `image_url`:** O campo está presente no schema de saída, mas contém `null` na execução atual. A API interna do iFood exige tokens de autorização que só o SPA React injeta automaticamente durante a navegação da página — chamadas diretas à API (mesmo com `cf_clearance` válido) retornam 403. O campo é extraído corretamente pelo pipeline (`logoUrl` do payload XHR) em novos crawls que interceptem a resposta via `page.on('response')`, mas não é recuperável retroativamente do cache sem re-crawl completo.

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

| Camada | Tecnologia | Cookie | Validade |
|---|---|---|---|
| TLS Fingerprinting | Cloudflare | `cf_clearance` | ~30 min |
| Bot Detection | PX HUMAN Security | `_px3` | ~2s pós-solve |

**Fluxo por produto:**

```
1. Worker navega para a URL do produto (page.goto)
2. React SPA dispara XHR para /site-api/v1/merchants/.../items/...
3. page.on('response') intercepta a resposta JSON → extrai preço
4. Se status=200 com dados → salva e avança
5. Se status=403 (PX challenge) — PX Mutex Solver:
   └── 1º worker adquire mutex e executa hold adaptativo (6–15s no botão)
   └── Widget aceita o gesto → botão removido do DOM → mouse.up liberado
   └── _px3 validado é propagado para TODOS os contextos do Chrome
   └── ATENÇÃO: a SPA recarrega a página após o solve (comportamento esperado)
   └── Demais workers aguardam o mutex e recebem 'waited'
   └── Após solve: cada worker faz fetch imediato NA SUA PRÓPRIA ABA (400ms)
   └── O fetch DEVE ocorrer nessa janela de ~2s — após o reload da SPA,
       um novo _px3 não-validado é emitido e o fetch volta a retornar 403
6. Salva resultado no cache incremental (/tmp/px-batch-results.json)
```

> **Por que o fetch é imediato por worker (não em batch na aba do solver)?**
> O cookie `_px3` é compartilhado entre todos os contextos do Chrome. Após o solve,
> cada worker faz `page.evaluate(fetch)` na sua própria aba aproveitando o `_px3`
> recém-validado. O único requisito é que isso ocorra **antes** do reload da SPA
> (~2s), que emite um novo `_px3` não-validado e invalidaria a janela.

> **Por que a página recarrega após o solve?** É comportamento normal da SPA do iFood
> — o widget PX faz `window.location.reload()` internamente ao validar o gesto.
> Isso é esperado e não indica falha no solve.

> **Por que IPs "queimados" falham mesmo com solve correto?**
> O PerimeterX mantém reputação de IP em nível de rede. Um IP flagrado (por
> excesso de requisições ou padrão de bot) recebe 403 no fetch da API mesmo
> com `_px3` válido. A solução é usar IP residencial limpo (hotspot, proxy
> residencial) — o mesmo solve que retorna 403 num IP queimado retorna 200
> num IP limpo.

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

# FlareSolverr — renovação automática de cf_clearance (opcional, ver seção abaixo)
FLARESOLVERR_URL=http://localhost:8191/v1
```

A concorrência padrão é **3 workers** (recomendado). O Mutex Solver garante que 1 solve serve todos os workers simultaneamente via cookie compartilhado — aumentar além de 5 tem retorno decrescente e aumenta a pressão sobre o IP.

---

## FlareSolverr — Renovação Automática de cf_clearance (opcional)

O `cf_clearance` expira em ~30 min. O FlareSolverr resolve o Cloudflare automaticamente em background, eliminando a necessidade de reabrir o Chrome manualmente.

### Subir o serviço

```bash
docker compose up -d flaresolverr
```

O serviço fica disponível em `http://localhost:8191`. Com `FLARESOLVERR_URL` definido no `.env`, o pipeline verifica e renova o `cf_clearance` automaticamente antes de cada crawl (etapa 4.5 do `run-all.mjs`).

### Renovação manual

```bash
npm run cf:renew
```

É um no-op se o cookie ainda estiver válido (expira em > 5 min).

> **Requer Docker instalado.** O FlareSolverr roda em container Linux — não precisa de Chrome extra, usa seu próprio Chromium headless internamente para resolver o Cloudflare.

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
| `200` sem dados | Produto indisponível/fora da área de entrega — `status: "error"`, `error_message: "UNAVAILABLE: ..."` |
| URL com `desativada` no slug | Loja desativada no iFood — `status: "error"`, `error_message: "DEACTIVATED: ..."` |
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

> As 358 falhas se dividem em duas categorias registradas no output:
> - **53 DEACTIVATED** — lojas com `desativada` no slug da URL: lojas permanentemente desativadas no iFood, independente de endereço ou sessão.
> - **305 UNAVAILABLE** — produto não retornou preço: combinação de bloqueio de bot (403, ~30% das tentativas nos logs) e itens fora da área de entrega do endereço-âncora (200 sem dado de preço, ~65%). Ambas as categorias são indistinguíveis no output final pois o cache só persiste sucessos.

---

## Limitações Conhecidas

1. **Requer Chrome headful local** — Cookies vinculados ao fingerprint TLS do Chrome. Não funciona em Docker headless (Chromium open-source tem fingerprint diferente e é detectado pelo Cloudflare).
2. **Throughput limitado pelo PX solve** — ~6–15s por solve (hold adaptativo). Com 3 workers e IP limpo: ~9–15 itens/minuto. Cada ciclo de solve serve todos os workers em paralelo via cookie compartilhado.
3. **Sensível à reputação do IP** — IPs queimados (flagrados pelo PerimeterX por abuso anterior) retornam 403 mesmo após solve correto. Use IP residencial limpo: hotspot móvel ou proxy residencial rotativo. Sintoma: solve funciona (botão removido) mas todos os fetches retornam 403.
4. **Chrome headful single-instance** — O solve PX usa `page.mouse` via CDP (não mouse físico). Exige Chrome visível (não headless). Rodar duas instâncias com o mesmo profile causa conflito de cookies.
5. **Sessão expira (~30 min)** — Se `cf_clearance` expirar: com FlareSolverr em execução, renovado automaticamente. Sem FlareSolverr: reabra Chrome com `npm run chrome` e navegue para https://www.ifood.com.br.
6. **Cobertura por endereço-âncora** — Lojas fora da área de entrega do endereço setado no profile retornam 200 sem dados de preço (categorizadas como `UNAVAILABLE`).
7. **`image_url` é `null` no dataset atual** — A API interna exige tokens de autorização injetados pela SPA. O campo é extraído em novas execuções via `page.on('response')`, mas não é recuperável retroativamente do cache.

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

**Com FlareSolverr (Docker):**
```bash
docker compose up -d flaresolverr   # se ainda não estiver rodando
npm run cf:renew                    # injeta cf_clearance no Chrome
npm run crawl                       # retoma
```

**Sem FlareSolverr (manual):**
1. Encerre o processo aberto via `npm run chrome` (Ctrl+C no terminal dele).
2. Reabra com `npm run chrome`.
3. Navegue manualmente para https://www.ifood.com.br e resolva o Cloudflare/login até a home carregar normalmente.
4. Retome `npm run crawl` — o resume automático pula o que já foi processado.

**`❌ data/products_output.json não encontrado`**

Rode o snippet do passo 2 do Quick Start.

**Pipeline trava em "Verificando Chrome CDP"**

Verifique se a porta 9222 está acessível: `curl http://127.0.0.1:9222/json/version`. Se não responder, o Chrome com CDP não está rodando — execute `npm run chrome` em outro terminal.

---

**Solve funciona (botão removido) mas 100% dos fetches retornam 403**

O IP está queimado — o PerimeterX bloqueou o IP em nível de rede. O gesto é aceito pelo widget (comportamento correto) mas o backend rejeita as requisições independente do `_px3`.

```
Sintoma no log:
  [W1][PX] PX: botao removido durante hold (6400ms)
  [W1][PX] PX: resolvido (botao removido pos mouse.up)
  [W1][rodada-1 3/215] ❌  | status=403   ← mesmo após solve
```

**Solução:** troque o IP.
```bash
# 1. Conecte o Mac ao hotspot do celular (ou ative proxy residencial)
# 2. Encerre o Chrome para limpar conexões TCP abertas
pkill -f "Google Chrome"
# 3. Reinicie o Chrome no novo IP
npm run chrome
# 4. Rode o crawl do zero
npm run crawl:reset
```

> **Por que trocar o IP resolve?** O PerimeterX avalia a reputação do IP independentemente do cookie. Um IP residencial limpo (celular 4G/5G, por exemplo) não tem histórico de abuso e o `_px3` validado é aceito normalmente.

---

**A página recarrega após o solve — isso é normal?**

Sim. A SPA do iFood executa `window.location.reload()` internamente ao validar o widget PX. Isso é comportamento esperado e não indica falha. O importante é que o fetch da API ocorra **antes** desse reload (~400ms após o solve), enquanto o `_px3` validado ainda está ativo. Após o reload, a SPA emite um novo `_px3` não-validado e o ciclo de challenge começa novamente para o próximo item.

---

## Melhorias Futuras

- **CAPTCHA solver pago como fallback automático** — integrar [CapSolver](https://capsolver.com) ou [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) (ADRs [0009](docs/adr/0009-capsolver-cloudflare-challenge.md) e [0010](docs/adr/0010-flaresolverr-free-alternative.md)) para remover dependência do solve manual via mouse físico e permitir paralelismo real entre máquinas.
- **Proxy residencial rotativo** — distribuir o tráfego entre múltiplos IPs/sessões reduziria a frequência dos challenges PX (ver [ADR-0008](docs/adr/0008-residential-proxy.md)).
- **Persistência em banco** — substituir os JSONs por SQLite/Postgres facilitaria queries e dashboards.
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
  renew-cf-clearance.mjs    ← renova cf_clearance via FlareSolverr
  generate-report.mjs       ← dashboard de métricas (npm run report)
  remerge.mjs               ← re-merge manual de resultados parciais
  lib/
    cli.mjs                 ← parsing de args (hasFlag, getOption)
    logger.mjs              ← createLogger (info/warn/error/header)
    process.mjs             ← run(cmd, args) — spawn com log em arquivo
    groups.mjs              ← slugToGroup + splitIntoGroups
    px-solver.mjs           ← PX Mutex Solver (ensurePxSolved)
    xhr-capture.mjs         ← captureItemXhr (intercepção XHR do iFood)

data/
  products_output.json      ← base (título + URL + imagem, sem preço)
  products_output_enriched.json  ← saída final (com preços)
  groups/                   ← URLs segmentadas por loja

tests/unit/                 ← 113 testes unitários (Vitest)
docs/evidence/              ← logs e relatórios de execução
```
