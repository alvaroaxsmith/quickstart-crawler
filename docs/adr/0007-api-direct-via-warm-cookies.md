# Estratégia API-direct via cookies aquecidos (em vez de hidratação client-side)

## Status

Aceita — Marco 7 (validada com 4/5 ok + 1 not-found canônico em URLs reais).

## Context

ADR-0002 elegeu **interceptação de API** como caminho primário de extração:
deixar a SPA do iFood hidratar e capturar as chamadas que ela própria faz
(`merchant-info`, `menu/items`, etc.) via `page.on('response')`. ADR-0006
adicionou profile persistente + Chrome real + stealth para passar pelo
Cloudflare.

Durante a validação real (Marco 6 → 7) descobrimos:

1. **Mesmo com tudo aquecido**, o iFood passou a exibir um Turnstile de
   "pressione e segure" antes de hidratar a SPA. Sem resolver, a chamada de
   catálogo nunca é disparada — `apiHits` fica sem o endpoint de preço.
2. O **auto-solver de Turnstile** (`scripts/_turnstile.ts`) é frágil:
   numa rodada disparou 5/5 e resolveu 5/5; na rodada seguinte (mesma máquina,
   mesmo profile) reportou `absent` em 5/5 e a hidratação congelou — soft-ban
   ou A/B test do iFood, indistinguível.
3. **Refrescar profile + warm-up humano** recuperou `apiHits` de 2 → 4, mas
   continuou sem o endpoint de catálogo.

A partir daí pivotamos para uma sondagem direta da API REST
(`scripts/probe-catalog.ts`, 28 endpoints candidatos). Descobrimos que o
iFood expõe um endpoint REST público autoritativo:

```
GET /site-api/v1/merchants/{merchantId}/items/{itemId}
```

retornando `unitPrice`, `promotionalPrice`, `availability`, `enabled`,
`description`, `details`, `logoUrl`, `ean`, `externalCode`, `pluCode`,
`sellingOption`. **Não dispara Turnstile**, **não depende de hidratação**, e
funciona com qualquer contexto que tenha cookies aquecidos pelo
`page.goto(productUrl)`.

## Decision

**A estratégia primária de extração passa a ser API-direct via cookies
aquecidos.** ADR-0002 (interceptação) é rebaixada a fonte secundária para
metadata (não para preço).

### Fluxo canônico por URL

1. `page.goto(productUrl, { waitUntil: 'domcontentloaded' })`
   — estabelece cookies (`cf_clearance`, sessão, anti-bot).
2. `extractIdsFromUrl(url)`
   — parse determinístico de `merchantId` (path[3]) e `itemId` (query
   `?item=`), validados por regex UUID. **Sem DOM.**
3. `page.request.get('/site-api/v1/merchants/{m}/items/{i}', { headers: {
   Accept, Referer: productUrl, Accept-Language: pt-BR } })`
   — chamada REST direta, usando os cookies do contexto.
4. Parse de `body.data.menu[0].itens[0]` → mapeia para domínio:
   - `unitPrice` → `Product.unitPriceCents = Math.round(v * 100)`
   - `promotionalPrice` → `Product.promotionalPriceCents`
   - `availability === 'AVAILABLE' && enabled` → `Product.available`
   - `description` → `Product.name`
   - 404 → `MERCHANT_INACTIVE` / `ITEM_NOT_FOUND` (não-retentável)
5. Se o item-endpoint retornar 404, complementar com
   `merchant-info/graphql?latitude=…&longitude=…&channel=IFOOD`. **Ambos
   404** = `MERCHANT_INACTIVE` definitivo (validado em URL real
   "desativada-fenix").

### Pré-requisitos (herda ADR-0006)

- Chrome real (`channel:'chrome'`) + `playwright-extra` + stealth.
- `launchPersistentContext('fixtures/browser-profile/')` aquecido pelo
  `bootstrap-address.ts`.
- **Headful obrigatório.** Em headless puro o item-endpoint retorna 403
  (mesmo com cookies). Validado empiricamente.

## Considered Options

| Opção | Decisão | Motivo |
|---|---|---|
| A) Interceptação client-side (ADR-0002 original) | ❌ rebaixada | Depende de Turnstile resolvido + hidratação completa; instável |
| B) Auto-solver de Turnstile + interceptação | ❌ | Já implementado em `_turnstile.ts`; validação real ficou 0/5 quando o desafio simplesmente "não apareceu" e a hidratação congelou — não é confiável |
| C) Parsing do SSR `__NEXT_DATA__.productData` | 🟡 fallback | Tem nome/descrição/IDs mas **não tem preço** — só serve como degradação |
| **D) API-direct via `page.request.get` com cookies aquecidos** | ✅ | Validada 4/4 nas URLs com loja ativa; 404 canônico nas inativas; sem Turnstile, sem hidratação |
| E) `tls-client`/`curl_cffi` HTTP direto (sem browser) | ❌ | Perde-se o profile aquecido; reverter o handshake é alto esforço; viola ADR-0006 |
| F) Catalog endpoint inteiro (~200kb) | ❌ | Funciona mas é 200× maior que o item-endpoint; reservar para uso futuro (inventário completo) |

## Consequences

**Positivas:**
- **Solver de Turnstile sai do caminho crítico.** Permanece como salvaguarda
  em `_turnstile.ts` (zero-cost se ausente), mas o sucesso não depende mais
  dele.
- **Extractor drasticamente mais simples:** parser de JSON tipado em vez de
  DOM scraping ou agregação de múltiplos endpoints interceptados.
- **Resposta determinística para lojas inativas:** 404 vs 200, sem
  ambiguidade visual.
- **Payload 200× menor** que o catalog completo (1 kb vs 200 kb) — escala
  melhor para 1000 URLs.

**Negativas / Trade-offs:**
- **Headful obrigatório** mantido (já era requisito de ADR-0006). Headless
  puro retorna 403 no item-endpoint.
- **Cada URL ainda paga 1 `page.goto`** para aquecer cookies. Otimização
  futura: reutilizar mesma página para várias URLs da mesma loja
  (`merchantId` comum), invocando `page.request.get` em paralelo.
- **Acoplamento a um endpoint REST não-documentado** do iFood. Se mudar de
  forma, refazer probe. Mitigação: `probe-catalog.ts` versionado como
  ferramenta de diagnóstico permanente.
- **ADR-0002 fica parcialmente revogada.** Manter o histórico para
  rastreabilidade da decisão.

## Mitigations

- `scripts/probe-catalog.ts` permanece no repo como ferramenta de
  re-descoberta. Se o endpoint mudar, re-rodar e atualizar.
- `_turnstile.ts` mantido como salvaguarda — invocado em
  `capturePage` antes da chamada REST, sem custo se não houver desafio.
- Fallback documentado: SSR `productData` provê nome/descrição mesmo se a
  API quebrar (degradação graciosa para evitar perda total de execução).
- `fixtures/probes/` é gerado sob demanda por `probe-catalog.ts` e está em
  `.gitignore` — bodies grandes não versionados, regeneráveis a custo zero.

## Related

- Substitui parcialmente: ADR-0002 (API interception primary).
- Depende de: ADR-0006 (session and persistent profile).
- Referenciada por: `scripts/capture-fixtures.ts` (refatorado Marco 7),
  futuro `src/adapters/fetcher/playwright-fetcher.ts` (B3).
