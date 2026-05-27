# iFood — Endpoints e Sinais Observados (Marco 6)

Documenta o que foi efetivamente capturado em `fixtures/captures/` rodando
`scripts/capture-fixtures.ts 5` com profile aquecido (`Av Paulista, 1000, SP`).

> **Status:** B1 parcial. O endpoint de **catálogo / item específico** ainda
> não foi capturado — Cloudflare **Turnstile interativo** ("Pressione e
> segure para confirmar que você é humano") bloqueia a hidratação que
> dispararia a chamada. Ver §Bloqueador.

---

## Endpoints capturados

Todos requerem cookies de sessão (`cf_clearance`, `session-token` etc. do
profile aquecido) e/ou coordenadas no query string.

### 1. `consumer-api.ifood.com.br/ip` — Geolocalização IP

- Disparado uma vez por sessão.
- Retorna **45 bytes** com o IP do cliente.
- **Não é fonte de dado de produto**, mas marca o ciclo de vida da sessão.

### 2. `site-api/v1/merchant-info/graphql` — Metadata do merchant ⭐

URL com `latitude=&longitude=` (sem coords) é a **primeira chamada**, retorna
um payload "vazio" do merchant; URL com coords reais (`-23.564802`,
`-46.6518207`) traz o objeto completo.

```
GET https://www.ifood.com.br/site-api/v1/merchant-info/graphql
    ?latitude=<lat>&longitude=<lng>&channel=IFOOD
```

**Payload (extraído):**
```json
{
  "data": {
    "merchant": {
      "id": "5938ca36-c5ee-455b-b0ce-8211f1921be5",
      "name": "Pão de Açúcar - Águas Claras",
      "available": false,
      "availableForScheduling": true,
      "currency": "BRL",
      "distance": 866.9,
      "deliveryTime": ...,
      "deliveryMethods": [...],
      "features": [...],
      "id": "...",
      "mainCategory": {...},
      "minimumOrderValue": 60,
      "preparationTime": ...,
      "priceRange": ...,
      "resources": [...],
      "slug": "...",
      "tags": [...],
      "userRating": ...
    }
  }
}
```

**Sinais críticos para o domínio:**
- `merchant.available === false` + `distance > X km` → **`OUT_OF_DELIVERY_AREA`**.
- `merchant.name` → `Product.merchantName` (já temos no domínio).
- `merchant.id` → confirma o UUID do path da URL.

### 3. `site-api/v2/categories` — Categorias do merchant

- 486 bytes (lista simples).
- Útil para popular `Product.category` se o item-endpoint não tiver.

### 4. `site-api/v1/review/evaluations?filterJson=…` — Avaliações

- ~16 kb por loja, paginado.
- Irrelevante para o crawler atual (não pedimos rating).

### 5. ⭐ Endpoint de **item** — DESCOBERTO via `probe-catalog.ts`

`GET /site-api/v1/merchants/{merchantId}/items/{itemId}`

- **Status:** 200 (~1 kb) ou 404 (item/loja inexistente).
- **Requer:** cookies do contexto aquecido por `page.goto(productUrl)` antes.
  Em headless puro retorna **403** (verificação de browser real).
- **Não depende** de Turnstile resolvido nem de hidratação client-side.

Payload (campos relevantes):

```json
{
  "code": "00",
  "data": {
    "menu": [{
      "code": "",
      "name": "",
      "itens": [{
        "id": "c2296a33-…",
        "code": "c2296a33-…",
        "description": "Desengordurante Spray Veja Cozinha Limão Oferta 500ml",
        "details": "Embalagem 500ml",
        "logoUrl": "…/produto.jpg",
        "unitPrice": 31.99,
        "promotionalPrice": 23.99,
        "availability": "AVAILABLE",
        "enabled": true,
        "ean": "",
        "externalCode": "80840355",
        "pluCode": "183871",
        "sellingOption": { "minimum": 500, "incremental": 500, "availableUnits": ["UNIT"] },
        "type": "DEFAULT"
      }]
    }]
  }
}
```

**Mapeamento direto para o domínio:**
- `unitPrice` → `Product.unitPrice` (cents = `Math.round(unitPrice * 100)`)
- `promotionalPrice` → `Product.promotionalPrice`
- `availability` (`"AVAILABLE"`/`"UNAVAILABLE"`) + `enabled` → `Product.available`
- `description` → `Product.name`
- `details` → `Product.details` / atributo
- `ean`, `externalCode`, `pluCode` → identificadores externos
- 404 → `MERCHANT_INACTIVE` ou `ITEM_NOT_FOUND`

**Cathedral:** este é o **endpoint autoritativo** do crawler. O resto
(`merchant-info`, SSR) é metadata complementar.

#### Outros endpoints 2xx mapeados pelo probe

- `GET /site-api/v1/merchants/{merchantId}/catalog` → catálogo inteiro (~200 kb)
  com todas as categorias e itens. Útil se um dia precisarmos rastrear o
  inventário completo de uma loja, mas hoje preferimos o item-endpoint
  (200× menor, mais focado).
- `GET /site-api/v2/categories?merchantUuid=…` → **400 Bad Request**
  (falta algum query param desconhecido — ignorado).

### 6. ⭐ SSR (`__NEXT_DATA__`) — fonte parcial sem hidratação

O HTML SSR de `/Merchant/Merchant` (todas as URLs `?item=…`) já contém
`__NEXT_DATA__.props.initialProps.pageProps.productData`:

```json
{
  "logoUrl": "…/produto.jpg",
  "description": "Desengordurante Spray Veja Cozinha Limão Oferta 500ml",
  "details": "Embalagem 500ml",
  "merchantName": "Pão de Açúcar - Águas Claras",
  "merchantLogo": "…/merchant.png",
  "itemId": "c2296a33-6a72-415b-888b-9c9ed1b5b5fd"
}
```

**Disponível sem Turnstile resolvido.** Útil como fallback (`name`,
`description`, `merchantName`). **Não contém preço** — preço só aparece
após hidratação (`restaurant.menu`, `dishModal`, `catalogCategory` no
`initialState` ficam vazios no SSR e são populados via chamada de catálogo).

Quando a URL não resolve um merchant (ex.: capture #5 `Fenix Pamplona`), o
Next.js redireciona para `page: '/Landing/Landing'` e `productData` é
`undefined` — sinal para categorizar como `PARSING_ERROR` ou similar.

---

## Bloqueador: Cloudflare Turnstile interativo

A partir do Marco 5c (Chrome real + `playwright-extra` + stealth-plugin), o
**loop infinito de Cloudflare foi eliminado**, mas o iFood passou a exibir
**um Turnstile de uma etapa só**:

> _"Antes de continuarmos…  
> Pressione e segure para confirmar que você é humano (e não um bot)."_

Características:
- Modal centralizado, botão azul "Pressione e segure".
- Requer **mouse-down sustentado por ~5-10 s** sobre o botão.
- Texto distintivo no DOM: `Antes de continuarmos`, `Pressione e segure`.
- Aparece em **todas as URLs de catálogo** (`/delivery/<cidade>/<loja>/<uuid>?item=…`).
- **Não bloqueia o SSR inicial** — esqueleto da loja renderiza, mas a
  hidratação fica congelada → endpoint de catálogo nunca é chamado.

**Marca de detecção** (a usar no fetcher):
```ts
const hasTurnstile = await page
  .getByText(/antes de continuarmos|pressione e segure/i)
  .first()
  .isVisible()
  .catch(() => false)
```

### Estratégias candidatas (em ordem de risco crescente)

| # | Estratégia | Risco | Esforço |
|---|---|---|---|
| A | **Auto-press-and-hold:** detectar o botão, executar `page.mouse.down()` → `waitForTimeout(8s)` → `mouse.up()` | Médio (pode falhar checks de movimento) | Baixo |
| B | **Aquecer profile com Turnstile resolvido manualmente uma vez** e confiar que `cf_clearance` cobre as próximas N visitas | Baixo (mas exige sessão renovada periodicamente) | Mínimo |
| C | Usar `tls-client` ou `curl_cffi` para imitar Chrome TLS via HTTP direto à API (pular SPA) | Alto (precisaria reverter o GraphQL) | Alto |
| D | Plugin/extension dedicado a Turnstile (`puppeteer-extra-plugin-turnstile` ou similar) | Médio | Médio |

**Decisão (Marco 6):** **Estratégia A** — automação completa via
`page.mouse.down → hold(~7s com micro-jitter) → mouse.up` sobre o centro do
iframe do Turnstile. Manual está descartado: o projeto tem 1000 URLs e
automatização end-to-end é requisito explícito. Implementação em
`scripts/_turnstile.ts` (função `solveTurnstileIfPresent`), reutilizada pelo
`bootstrap-address.ts`, `capture-fixtures.ts` e (futuramente) pelo
`PlaywrightFetcher`.

**Atualização (Marco 7):** Turnstile **não aparece** quando vamos direto à
API via `page.request.get(item-endpoint)` após `page.goto(productUrl)`. O
solver continua no fluxo como salvaguarda mas raramente dispara. A estratégia
canônica passou a ser **API-direct via cookies aquecidos** — ver §5 acima.

---

## Heurística de "captura suspeita" — atualizada

A `capture-fixtures.ts` reportava `status: ok` quando deveria ser `blocked`.
Sinais que indicam **falsa captura**:

- HTML contém `Antes de continuarmos` **ou** `Pressione e segure`.
- HTML contém `Fora da área de entrega` **e** `apiHits` não tem endpoint de catálogo.
- Nenhum endpoint cujo path contenha `menu`, `catalog`, `item`, ou `products`.
- `R$\s*\d+` aparece somente em "taxa de entrega" / "pedido mínimo", não em produto.

Implementação: ver `scripts/capture-fixtures.ts` § "heurística de bloqueio".

---

## Coordenadas-âncora utilizadas

Profile aquecido com endereço `Avenida Paulista, 1000, São Paulo` resolveu para:

- `latitude = -23.564802`
- `longitude = -46.6518207`

Bairro Bela Vista, próximo do MASP. Cobre majoritariamente SP capital — lojas em
Brasília-DF, Fortaleza-CE, Porto Alegre-RS e Campinas-SP retornam
`available: false` + `distance > 80 km` (categorizar como `OUT_OF_DELIVERY_AREA`,
não falha).

---

*Última atualização: Marco 7 — endpoint de item descoberto via
`probe-catalog.ts`. Estratégia API-direct entrega `unitPrice`,
`promotionalPrice`, `availability` em 4/5 URLs reais, com 404 canônico
para lojas desativadas (5/5).*
