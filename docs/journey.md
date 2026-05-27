# Diário Técnico — iFood Product Crawler

> Registro cronológico de desafios, descobertas e decisões técnicas durante a
> resolução do case. Complementa os ADRs (decisões formais) e o SPEC.md
> (requisitos), focando no **porquê** das escolhas e nos becos sem saída
> explorados.

---

## Linha do tempo

### Marco 0 — Entendimento do case

**Contexto recebido:** crawler para extrair `unitPrice`, `originalPrice` e
`minimumPromotionalPrice` de páginas de produto do iFood, com volume estimado
≥ 1.000 URLs, anti-bot, métricas e múltiplos formatos de saída.

**Premissas adotadas (não pedidas, mas implícitas):**

- Node.js + TypeScript (afinidade do time, ecossistema rico para scraping).
- KISS hoje, mas com **ports** definidos para permitir trocar adapters sem
  reescrever o domínio quando o volume escalar.
- Zero dependências além do estritamente necessário (custo cognitivo, supply
  chain). Resultado: `playwright` + `exceljs` apenas em runtime.

---

### Marco 1 — Decisões fundadoras (FASE 0)

**Pergunta:** HTTP puro ou navegador real?

- Páginas iFood são SPA (Next.js). Conteúdo dinâmico requer JS.
- HTTP-only (fetch + parser) **não funciona** para preços — confirmado
  empiricamente no Marco 5.
- **Decisão (ADR-0001):** Playwright + Chromium. Trade-off: ~150MB no
  filesystem, ~300MB RSS por instância, mas é o único caminho viável.

**Pergunta:** Como extrair os dados — DOM scraping ou intercepção de API?

- **Decisão inicial (ADR-0002):** API interna como caminho primário (mais
  estável a mudanças de CSS), DOM como fallback. **Esta decisão foi
  invalidada no Marco 5** e exigiu pivot (ver abaixo).

**Pergunta:** Arquitetura?

- **Decisão (ADR-0003):** Hexagonal/Clean. Domínio puro (`Product`, erros
  categorizados, `ExecutionReport`), aplicação orquestra via ports, adapters
  nas bordas. Justificativa: o crawler **vai ser plugado no sistema Gondola**
  (segundo o brief implícito), então isolar domínio de IO é mandatório.

**Pergunta:** Quão preparado para escala?

- Volume hoje: 1k URLs/dia. Volume potencial: 100k+/dia.
- **Decisão (ADR-0005):** Ports prontos para Redis/SQS/S3, mas adapters
  apenas in-memory/filesystem nesta entrega. Migração é só implementar nova
  classe contra o mesmo port.

---

### Marco 2 — Construção do domínio e adapters (FASE A)

**Sem surpresas notáveis.** Cobertura: 68 testes unitários, build limpo,
lint zero. Pontos a registrar:

- **Categorias de erro** (`CrawlErrorCategory`): foram modeladas como union
  type + `TRANSIENT_CATEGORIES` Set para classificar o que deve ser retentado.
  Útil para o circuit breaker do B6.
- **`ExecutionReport`**: estrutura definida no domínio, populada pelo
  `MetricsCollector` (adapter). Percentis calculados via sort + índice (sem
  dependência de biblioteca de stats — overkill para 1k samples).
- **`ResultSink` com `open/write/close`**: permite **streaming** em CSV (não
  carrega 100k linhas em memória) e **buffering** em JSON/XLSX (esses dois
  formatos exigem o documento inteiro antes de serializar).
- **`group-by-merchant`**: implementado no domínio porque é regra de negócio
  ("respeite o servidor por merchant"). `splitLargeBuckets` quebra buckets
  > 50 URLs para evitar starvation do scheduler.

---

### Marco 3 — Verificação estrutural

**Desafio:** garantir que **crawler / parser / storage** estejam separados,
conforme exigido pelo case (§13).

**Solução:** mapeamento explícito:

- **Crawler (fetcher):** `src/adapters/fetcher/` — implementa `PageFetcher`,
  só sabe `(url) -> {html, apiJson?, status, durationMs}`.
- **Parser (extractor):** `src/adapters/extractor/` — implementa
  `ProductExtractor`, só sabe transformar `FetchResponse → Product`.
- **Storage (sinks):** `src/adapters/storage/` — implementa `ResultSink`.

`.gitkeep` adicionado em `fetcher/` e `extractor/` para tornar a separação
visível antes mesmo da implementação.

---

### Marco 4 — Primeira captura de fixtures (B1, tentativa #1)

**Setup:** script `capture-fixtures.ts` com Chromium visível, `pt-BR`,
viewport realista, UA Chrome 124, interceptação de respostas via
`page.on('response')` filtrando paths `/(merchants|catalog|item|menu)/`.

**Resultado:** 4 de 5 URLs com `status=200`, **mas 0 chamadas de API
capturadas**. Suspeitei do filtro de paths.

**Investigação via REPL:**

- HTML tem 32k–114k bytes — não é página de bloqueio.
- `__NEXT_DATA__` presente, contém `productData = { logoUrl, description,
  details, merchantName, merchantLogo, itemId }`.
- **`unitPrice`, `originalPrice`, `price` — todos ausentes do HTML inicial.**
- Único `R$` no HTML: `R$ 0,00` (placeholder de UI).

**Conclusão:** preços são carregados **client-side após hydration**, via
chamadas XHR que meu filtro restritivo não pegou. Ampliei o filtro para
qualquer `*.ifood.com.br/*` JSON (excluindo trackers e assets).

---

### Marco 5 — A descoberta que mudou tudo

**Re-execução com filtro amplo + `waitForFunction(/R\$\s*\d/)`:**

```
[1/3] ... ok (status=200, api=1)
[2/3] ... ok (status=200, api=1)
[3/3] ... ok (status=200, api=1)
```

Apiece! Mas analisando o `_summary.json`:

```
1 ok apiHits: [ '/ip [200/45b]' ]
2 ok apiHits: [ '/ip [200/45b]' ]
3 ok apiHits: [ '/ip [200/45b]' ]
```

A única API chamada é um endpoint trivial `/ip` (geolocalização do
visitante). **Nenhuma chamada de catálogo.** Screenshot da página revela
um modal:

> "Tivemos um problema por aqui — Por algum motivo, não conseguimos
> carregar as informações necessárias."

Com o convite "Escolha um endereço" no topo direito.

**Diagnóstico:** o iFood **exige um endereço setado** antes de renderizar
qualquer dado de produto (incluindo preço). Sem endereço:

- Nenhuma chamada de API de catálogo é disparada.
- HTML inicial via SSR contém apenas metadata "fria" (logo, descrição
  estática, itemId) — útil para SEO, inútil para preço.

**Impacto:** ADR-0002 (API como caminho primário) fica **dependente de uma
sessão autenticada com endereço**. Sem isso, 0% das URLs retornam preço.

**Trade-offs avaliados com o usuário:**

| Opção | Prós | Contras |
|---|---|---|
| A — cookies/localStorage hardcoded | Determinístico | Endereço SP pode não cobrir loja BSB |
| B — CEP por cidade da URL | Robusto | Requer tabela cidade→CEP |
| C — `storageState` manual 1x | Simples, reusável | Endereço único pode falhar regionalmente |
| D — API pública sem endereço | Sem fricção | Não existe (descartado) |
| E — captura manual via DevTools | Zero código | Não escala para 1k URLs |

**Decisão do usuário:** **opção C** — bootstrap manual gera
`fixtures/storage-state.json`, reutilizado pelo crawler. Aceita-se que
algumas lojas (fora da área de entrega do endereço-âncora) terão preço
indisponível — isso será reportado como erro categorizado
(`out_of_delivery_area` ou similar), não como falha do crawler.

**Implementação:** `scripts/bootstrap-address.ts` abre Chrome visível,
aguarda usuário setar endereço, persiste `storageState`. Crawler real e
`capture-fixtures.ts` carregam esse arquivo automaticamente.

---

### Marco 5b — Cloudflare em loop com Chromium

Ao testar o bootstrap, o navegador abriu mas entrou em loop infinito de
challenge do Cloudflare. Diagnóstico: o **Chromium open-source** do
Playwright difere do Chrome real em (a) TLS handshake order e cipher
suites, (b) leaks específicos da build do Playwright. Cloudflare
identifica esses sinais mesmo com `launchPersistentContext`, stealth init
script e flags anti-automation.

**Decisão:** instalar Google Chrome (`brew install --cask google-chrome`)
e usar `channel: 'chrome'`. TLS passa a ser indistinguível de um Chrome
humano.

### Marco 5c — Cloudflare Turnstile ainda detecta CDP

Chrome real reduziu o loop, mas Cloudflare Turnstile ainda pedia
"confirme que você é humano" repetidamente. Causa: **leaks do Chrome
DevTools Protocol** (que o Playwright usa para controlar o browser) —
sinais como `Runtime.evaluate`, ausência de eventos de mouse reais, e
`navigator.webdriver` em frames profundos.

**Decisão (relaxa ADR-0001):** adicionar `playwright-extra` +
`puppeteer-extra-plugin-stealth` (subimos de 3 para 5 deps de runtime).
O stealth-plugin aplica ~17 patches conhecidos contra detecção, incluindo
mascaramento de CDP. Combinado com Chrome real + profile persistente +
stealth-plugin, o Cloudflare passou.

**Eliminação da etapa manual:** o `bootstrap-address.ts` foi reescrito
para automatizar todo o fluxo:

1. Abre Chrome real com stealth.
2. Aguarda Cloudflare liberar (sinal: input de endereço visível).
3. Digita endereço (env `ANCHOR_ADDRESS`, default Av Paulista 1000, SP) com delay humano.
4. Clica primeira sugestão do autocomplete.
5. Clica "Confirmar localização" no modal de mapa.
6. Aguarda re-render da home e exporta `storageState`.

Sem prompt, sem ENTER, sem interação. Bootstrap roda em ~30s e o profile
fica reutilizável até o `cf_clearance` expirar (~30min–2h).

---

### Marco 5e — Bootstrap idempotente

Ao rodar o bootstrap pela segunda vez (profile já aquecido), o script ficava
travado esperando o input de endereço — que **não existe** quando a home já
está com endereço aplicado. iFood renderiza dois layouts distintos:

- **Profile vazio:** home pede endereço (input grande visível, ou modal "Onde você está").
- **Profile aquecido:** home renderiza catálogo (chip "Av: …" no header + nav "Restaurantes/Mercados/…").

**Decisão:** o bootstrap virou idempotente via `Promise.race` entre dois
sinais distintos após o `goto`:

- `getByRole('link', {name: /mercados|restaurantes/i})` → home pronta → skip, exporta direto.
- `getByPlaceholder(/endereço|onde você está|qual o seu endere/i)` → fluxo completo.

Também tornamos o modal "Confirmar localização" opcional — alguns fluxos do
autocomplete setam o endereço sem abrir o modal de mapa.

Resultado: rodar `npx tsx scripts/bootstrap-address.ts` é seguro a qualquer
momento, sem efeitos colaterais. O script só atua quando há algo a fazer.

---

### Próximos marcos previstos (em aberto)

- **Marco 6:** re-capturar fixtures com profile aquecido. Confirmar
  endpoints de catálogo que carregam preço. Documentar em
  `docs/observed-selectors.md`.
- **Marco 7:** implementar `BrowserPool` (2–3 instâncias, RSS < 500MB
  combinado) e `PlaywrightFetcher` reutilizando o profile em todos
  os contextos (clonando para `tmp/profile-NN/` se Chrome reclamar de
  SingletonLock).
- **Marco 8:** decidir, com base no Marco 6, se `IfoodApiExtractor`
  continua como primário ou se `IfoodDomExtractor` (via `__NEXT_DATA__` +
  partes dinâmicas) assume.
- **Marco 9:** `UrlQueue` com semaforo por merchant, retry seletivo
  (apenas categorias transientes), circuit breaker.
- **Marco 10:** end-to-end no `index.ts`, geração das saídas finais.

---

## Lições aprendidas até aqui

1. **Não confie em SSR para SPAs comerciais.** O HTML inicial frequentemente
   é "marketing-grade" (SEO, OG tags, placeholder de UI), não "data-grade".
   Sempre instrumente uma captura real antes de projetar o parser.
2. **Filtros de interceptação devem começar amplos.** Restringir paths
   prematuramente esconde endpoints e leva a diagnóstico errado ("a página
   está bloqueada") quando o problema é só o filtro.
3. **Sessão é estado.** Crawlers de e-commerce/delivery quase sempre exigem
   contexto (endereço, login, carrinho). Isolar a aquisição de sessão num
   bootstrap automatizado mantém o crawler reproduzível sem ferir headlessness.
4. **Hexagonal paga juros cedo.** Quando ADR-0002 precisou ser revisitado, a
   única coisa que muda é o adapter do extractor — domínio, ports, sinks e
   métricas seguem intactos.
5. **Aceite "preço null" como cidadão de primeira classe.** Algumas URLs
   simplesmente não entregam preço (fora de área, item esgotado, loja
   fechada). O `Product` modela isso e o `ExecutionReport` categoriza —
   tentar forçar 100% de cobertura geraria falsos positivos.
6. **Cloudflare anti-bot é em camadas, defesa é em camadas.** Não existe
   uma "bala de prata". TLS fingerprint (Chrome real), CDP leaks
   (stealth-plugin), persistência de sessão (profile), comportamento humano
   (delay de digitação) — todos contribuem. Remover qualquer um quebra.
7. **Decisões de pureza arquitetural (ADR-0001 "deps mínimas") podem ceder
   diante de bloqueadores reais.** O importante é documentar a exceção e
   confinar o impacto — `playwright-extra` só é tocado em `scripts/_browser.ts`,
   o restante do código permanece independente.
8. **Scripts de bootstrap precisam ser idempotentes.** SPAs renderizam
   layouts diferentes conforme o estado da sessão. Seletor único quebra
   no segundo run. Usar `Promise.race` entre "estado já pronto" e "estado
   precisa-ação" deixa o script seguro de rodar quantas vezes for preciso.
9. **Cloudflare Turnstile interativo é uma camada acima das defenses
   passivas.** Mesmo com TLS humano + CDP-stealth + profile maduro, o iFood
   ainda exibe um modal "Pressione e segure para confirmar que você é
   humano". Ele não bloqueia o SSR (o esqueleto carrega), mas **congela a
   hidratação client-side** — então o endpoint de catálogo nunca é chamado.
   Detectar pela string `Antes de continuarmos` ou `Pressione e segure` no
   HTML e tratar como `status: blocked` na heurística.

---

## Marco 6 — Captura real revela Turnstile interativo

Primeira rodada de `scripts/capture-fixtures.ts 5` com profile aquecido
(coords `-23.564802, -46.6518207` = Av Paulista, SP).

**Achados:**

- Endpoints capturados em 5/5 URLs: `merchant-info/graphql`, `categories v2`,
  `review/evaluations`, `consumer-api/ip`, manifest. **Nenhum endpoint de
  catálogo/item** (esperado algo como `merchant-menu`, `items`, ou
  `products`) apareceu — o Turnstile bloqueou a hidratação.
- `merchant-info/graphql` é nosso candidato a **fonte de metadata e sinal de
  OUT_OF_DELIVERY_AREA**: payload retorna `merchant.available` e
  `merchant.distance` (em km). Captura #1 (Pão de Açúcar Brasília, com
  endereço-âncora SP): `available: false, distance: 866.9` — sinal canônico.
- **Bloqueador novo:** Cloudflare Turnstile "Pressione e segure" apareceu nas
  5 capturas. A heurística antiga reportou `status: ok` (falso positivo).
- **Heurística corrigida** em `capture-fixtures.ts`: detecta texto do
  Turnstile + ausência de endpoint de catálogo, marca como `blocked`.
- Documentação completa em [docs/observed-selectors.md](observed-selectors.md).

**Decisão (estratégia anti-Turnstile)** — **Estratégia A: auto-press-and-hold
totalmente automatizado**. Manual está descartado por requisito do projeto
(1000 URLs, sem passos manuais). Implementação em `scripts/_turnstile.ts`:
detecta `iframe[src*="challenges.cloudflare.com"]`, calcula centro via
`boundingBox()`, executa movimento humano até o alvo, `mouse.down()`, segura
~7s com micro-jitter para escapar de checks de imobilidade, `mouse.up()`,
espera o iframe sumir. Reutilizado pelo `bootstrap-address.ts`,
`capture-fixtures.ts` e (futuramente) pelo `PlaywrightFetcher`.

**Bônus descoberto:** o HTML SSR já contém `__NEXT_DATA__.props.initialProps.
pageProps.productData` com nome, descrição, itemId, merchantName e logo do
produto — **sem precisar de Turnstile resolvido**. Único campo faltante é o
preço, que só vem após hidratação. Isso é um fallback robusto para o
extractor (degradação graciosa quando Turnstile falhar).

---

## Marco 7 — Endpoint de item descoberto, estratégia API-direct

Após a validação do Marco 6 falhar (Strategy A não disparou em nenhuma URL,
apiHits caiu de 6 para 2 — soft-ban no profile), pivotamos para uma
estratégia mais robusta: **chamar a API direto via `page.request.get`** com
os cookies aquecidos pelo `page.goto(productUrl)`, sem depender da
hidratação client-side nem do Turnstile.

**Investigação (`scripts/probe-catalog.ts`):** Sondamos 28 endpoints
candidatos no padrão REST do iFood (variantes de path/version). **Dois
retornaram 200 com sinal de preço**:

1. `GET /site-api/v1/merchants/{merchantId}/catalog` (~200 kb) — catálogo
   inteiro da loja.
2. **`GET /site-api/v1/merchants/{merchantId}/items/{itemId}` (~1 kb)** —
   somente o item alvo. **Vencedor.**

**Payload do item-endpoint** (capturado em `fixtures/probes/…items_…json`):

```json
{
  "unitPrice": 31.99,
  "promotionalPrice": 23.99,
  "availability": "AVAILABLE",
  "enabled": true,
  "description": "…", "details": "…", "logoUrl": "…",
  "ean": "", "externalCode": "80840355", "pluCode": "183871",
  "sellingOption": { "minimum": 500, "incremental": 500, "availableUnits": ["UNIT"] }
}
```

**Refator do `capture-fixtures.ts`:** Para cada URL — `goto` para estabelecer
cookies, `extractIdsFromUrl(url)` (merchantId do path, itemId do query
`?item=`), `forceItemEndpoint(page, merchantId, itemId, refererUrl)`. Removi
a espera por `R$` no DOM (irrelevante agora). Heurística passou a usar o
**status do item-endpoint** como sinal autoritativo: `404 → not-found`,
`200 + unitPrice → ok`, resto → `blocked`/`error`.

**Validação (5 URLs reais):**

| # | Loja | unitPrice | promo | status |
|---|---|---|---|---|
| 1 | Pão de Açúcar Brasília | R$ 31,99 | R$ 23,99 | ok |
| 2 | Carrefour Hiper SP | R$ 17,42 | — | ok |
| 3 | Carrefour Hiper SP | R$ 23,39 | — | ok |
| 4 | Carrefour Hiper SP | R$ 14,68 | — | ok |
| 5 | "desativada Fenix…" | — | — | not-found (404 item + 404 merchant) |

**4/5 ok + 1 not-found canônico = 5/5 deterministicamente classificadas.**

### Lições deste marco

- **Lição 9 (atualizada):** Turnstile interativo é mitigável; mas a melhor
  defesa é **não acionar** o caminho que o invoca. SPA hidratada == bot
  surface. API direta == cookies + browser real bastam.
- **Lição 10:** O iFood expõe um endpoint REST público autoritativo
  (`/site-api/v1/merchants/{m}/items/{i}`) que retorna preço, promo e
  availability. Headless puro retorna 403; headful + profile aquecido
  retorna 200. **Significa que o BrowserPool ainda é necessário**, mas o
  Extractor fica drasticamente mais simples (parse de JSON direto, sem DOM).
- **Lição 11:** Quando uma estratégia falha em validação real (Strategy A
  Turnstile), **não persistir** na mitigação — investigar se há um caminho
  abaixo do problema. Aqui, em vez de "fazer o Turnstile funcionar",
  perguntamos "o que está atrás do Turnstile?" e descobrimos que o conteúdo
  está acessível por outra porta.
- **Lição 12 (process):** sondar endpoints é barato; investir 100 linhas
  num `probe-catalog.ts` economizou dias de engenharia de hidratação.

---

*Última atualização: ao final do Marco 7 (item-endpoint descoberto,
capture-fixtures pivot para API-direct, 4/5 ok + 1 not-found em validação).*
