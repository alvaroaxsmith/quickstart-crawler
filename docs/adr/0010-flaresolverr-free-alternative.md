# ADR-0010 — FlareSolverr como solver gratuito (opt-in)

## Status

Aceita — Marco 10 (opcional, em paralelo à ADR-0009).

## Contexto

A ADR-0009 adotou CapSolver (pago) para o estágio 2 do CF do iFood.
Para reduzir custo em dev/staging e oferecer um caminho 100% gratuito,
queremos um segundo adapter intercambiável.

[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) é um proxy
HTTP open-source que sobe um Chrome stealth dentro de um container e
expõe `POST /v1` com `cmd: "request.get"` — navega a URL, resolve o CF
challenge e devolve cookies + UA. É a solução gratuita mais consolidada
da categoria (>9 k ⭐ no GitHub).

## Decisão

Adicionar um segundo adapter (`flaresolverr-cloudflare.ts`) que
implementa a mesma porta `CloudflareSolver` definida no
[`session-warmer.ts`](../../src/adapters/fetcher/session-warmer.ts).
O warm-up não sabe qual provedor está sendo usado.

### Configuração

Env var nova:

```bash
FLARESOLVERR_URL=http://localhost:8191/v1
```

### Política de seleção no CLI

```text
FLARESOLVERR_URL setado?   -> usa FlareSolverr
senao CAPSOLVER_API_KEY?    -> usa CapSolver (ADR-0009)
senao                       -> só solver Turnstile local (ADR-0008 fallback)
```

FlareSolverr tem prioridade sobre CapSolver quando ambos estão setados
(otimiza custo). Trocar manualmente comentando a env de FlareSolverr.

### Como subir

```bash
docker run -d --name flaresolverr -p 8191:8191 \
  -e LOG_LEVEL=info ghcr.io/flaresolverr/flaresolverr:latest

# Sanity-check:
curl -X POST http://localhost:8191/v1 \
  -H 'content-type: application/json' \
  -d '{"cmd":"request.get","url":"https://www.ifood.com.br/","maxTimeout":60000}'
# Esperado: { "status": "ok", "solution": { "cookies": [...], "userAgent": "..." } }
```

## Trade-offs vs. CapSolver

| Dimensão | FlareSolverr | CapSolver |
| --- | --- | --- |
| Custo direto | US$ 0 | US$ 0,0008 / solve |
| Custo indireto | Manutenção do Docker | Monitorar saldo |
| Taxa de sucesso (CF enterprise) | ~30-50% | ~85-95% |
| Latência típica | 10-30 s | 5-15 s |
| Dependência externa | Imagem Docker pública | API SaaS paga |
| Atualização frente a CF | Comunidade (variável) | Equipe dedicada |
| Suporte a proxy residencial | sim (campo `proxy.url`) | sim (campo `task.proxy`) |
| Suporte a User-Agent custom | não (usa UA interno) | sim |

## Consequences

- ➕ Caminho 100% gratuito para dev/staging e para avaliação técnica.
- ➕ Mesma porta `CloudflareSolver`: zero impacto no warm-up. Trocar de
  provedor é trocar uma env var.
- ➕ Self-hosted: não vaza URLs/cookies para terceiros (compliance).
- ➖ Taxa de sucesso menor: em produção real iFood, esperar ~50% de
  falhas. Mitigação: rodar com `--retries` mais alto OU manter CapSolver
  como fallback (futura iteração — composite solver).
- ➖ FlareSolverr usa UA próprio do Chrome interno. Em alguns casos o
  CF amarra `cf_clearance` a esse UA + IP — se o nosso browser usar UA
  diferente, o cookie é invalidado. Mitigação: o `session-warmer` já
  recebe o `userAgent` devolvido pelo solver via `CloudflareSolution`,
  mas hoje não o aplica de volta ao contexto. Acompanhar nos smokes;
  se observarmos invalidação, adicionar `context.setExtraHTTPHeaders`
  + `Object.defineProperty(navigator, 'userAgent', ...)` antes do
  `reload()`.
- ➖ FlareSolverr não tem release oficial estável desde Q4-2024 (repo
  em manutenção esporádica). Risco operacional aceitável para uso
  gratuito.

## Implementação

- [`src/adapters/fetcher/flaresolverr-cloudflare.ts`](../../src/adapters/fetcher/flaresolverr-cloudflare.ts):
  adapter HTTP, fetch injetável para testes.
- [`src/cli/index.ts`](../../src/cli/index.ts): lê `FLARESOLVERR_URL`,
  monta solver com prioridade sobre CapSolver.
- [`tests/unit/adapters/fetcher/flaresolverr-cloudflare.test.ts`](../../tests/unit/adapters/fetcher/flaresolverr-cloudflare.test.ts):
  6 testes (endpoint inválido, happy path com proxy, sem proxy, status
  error, cookies vazios, HTTP não-ok).

## Validação esperada

```bash
docker run -d --name flaresolverr -p 8191:8191 \
  ghcr.io/flaresolverr/flaresolverr:latest

echo 'FLARESOLVERR_URL=http://localhost:8191/v1' >> .env

rm -rf /tmp/ifood-flaresolverr
LOG_LEVEL=debug npm run dev -- \
  --input fixtures/urls-sample-3.csv \
  --output out/smoke-flaresolverr \
  --concurrency 2 --no-resume \
  --profile /tmp/ifood-flaresolverr
```

Critério de **avaliação** (não de sucesso, dado o trade-off):
- Log deve mostrar `flaresolverr: solver remoto habilitado` na inicialização.
- Se warm-up passar: `solver remoto resolveu (N cookie(s))`.
- Medir taxa de sucesso em ≥ 10 execuções para decidir se é viável em
  produção ou se mantém CapSolver como default.

## Trabalho futuro

- Adapter composite `CompositeCloudflareSolver(primary, fallback)` que
  tenta FlareSolverr primeiro e cai no CapSolver em caso de falha.
  Reduz custo CapSolver para ~10-20% do volume, mantendo SLA.
