# Interceptação de API interna como estratégia primária de extração

> **REVISÃO Marco 7 (ver ADR-0007 e `docs/journey.md`):** esta decisão foi
> **rebaixada**. A interceptação client-side depende da SPA hidratar, o que por
> sua vez depende de Cloudflare Turnstile resolvido — instável na prática
> (validação real ficou 0/5 numa rodada). A estratégia primária passou a ser
> **API-direct via `page.request.get` com cookies aquecidos** (ADR-0007),
> chamando o endpoint canônico
> `/site-api/v1/merchants/{m}/items/{i}` descoberto via
> `scripts/probe-catalog.ts`. Interceptação permanece útil para metadata
> complementar (`merchant-info/graphql`), mas não para preço.

> **REVISÃO Marco 5 (ver `docs/journey.md`):** a premissa de que `__NEXT_DATA__` poderia
> servir como fallback **caiu**. O SSR do iFood entrega apenas metadata fria
> (logoUrl, description, details, merchantName, itemId) — **sem preço**. Preços só
> aparecem via API client-side, e só são disparados quando há endereço setado na
> sessão (ver ADR-0006). Consequência: a interceptação de API deixa de ser apenas
> "estratégia primária" e passa a ser **única fonte de preço**. O fallback DOM cobre
> apenas metadata (title, image) — preço fica `null` se a API não respondeu.

O iFood renderiza dados de produto via uma API interna (padrão observado:
`marketplace.ifood.com.br/v*/items/**` ou similar). Poderíamos extrair dados exclusivamente
via seletores CSS do DOM renderizado, mas esses seletores mudam com deploys de frontend —
gerando flakiness e manutenção contínua. A resposta JSON da API interna é estruturalmente
estável (contrato de API evolui com versionamento, não muda a cada deploy de CSS).

Usamos `page.on('response')` do Playwright para interceptar **todas** as respostas JSON
do domínio `*.ifood.com.br/*` durante a navegação normal da página. Se uma resposta com
preço for capturada em até 8s, extraímos do JSON (primário). Se não for capturada (loja
fora de área, CORS, timeout), o Product é gravado com preço `null` e categoria
`OUT_OF_DELIVERY_AREA` ou `PARSE_FAILURE`.

## Considered Options

- **DOM-only**: Mais simples (sem lógica de interceptação), mas frágil a mudanças de CSS.
- **API-only (sem browser)**: Chamada HTTP direta à API interna. Não funciona — a API provavelmente
  exige cookies de sessão que só existem após a navegação pelo browser.
- **API primária + DOM fallback (escolhido)**: Melhor taxa de sucesso na prática;
  o fallback protege contra mudanças de roteamento da API.

## Consequences

- O endpoint real da API interna deve ser confirmado na Task B1 antes de codar `playwright-fetcher.ts`.
  Se o padrão for diferente de `**/marketplace.ifood.com.br/**`, o `page.route()` regex precisa
  ser ajustado — mas isso é uma linha de configuração, não uma mudança arquitetural.
- Manter fixtures reais (HTML + JSON capturado) em `fixtures/` é obrigatório para que os
  testes unitários dos extratores não dependam de rede.
