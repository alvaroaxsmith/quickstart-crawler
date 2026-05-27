# Proxy residencial obrigatório em produção

## Status

**Parcialmente aceita / Insuficiente — Marco 8.** Proxy residencial BR
*é condição necessária* para o warm-up entrar no fluxo "humano" do CF (com
widget Turnstile), mas **não é suficiente**: o iFood encadeia um segundo
estágio de challenge (JS-only, sem widget) que o solver atual não pode
interagir. Superseded por **ADR-0009 (CapSolver para Cloudflare Challenge)**
em produção real. Mantemos esta ADR aceita porque o proxy continua sendo
uma das duas pernas obrigatórias da solução.

## Context

ADRs 0006 (profile persistente + Chrome real) e 0007 (API-direct via cookies
aquecidos) entregam um warm-up que, em laboratório, obtém `cf_clearance`
válido e dispara `GET /site-api/v1/merchants/{m}/items/{i}` com 200 OK.

Durante a validação E2E (smoke 3/3, várias rodadas) o Cloudflare Bot
Management do iFood começou a operar em modo **always-challenge** para o
nosso par `[IP residencial doméstico fixo + browser automatizado]`:

| Tentativa de mitigação                                | Resultado |
| ----------------------------------------------------- | --------- |
| `playwright-extra` + `puppeteer-extra-plugin-stealth` | Bloqueio  |
| `patchright` (fork do Playwright com patches profundos)| Bloqueio |
| `ghost-cursor-playwright` (mouse Bezier humanizado)   | Bloqueio  |
| Resolver Turnstile 10x consecutivos (frames API)      | Token aceito pelo widget, rejeitado pelo CF |
| Aumentar `cloudflareTimeoutMs` para 180s              | Sem efeito |

Em **todos** os casos o iframe do Turnstile desaparece (`solved`), mas o
Cloudflare **imediatamente emite um novo challenge**. O título da página
permanece `"Um momento..."` indefinidamente. No mesmo IP, com Chrome real
operado manualmente, basta **um clique** para liberar a página.

Diagnóstico: o sinal que o CF usa para nos barrar não é o IP nem o
fingerprint do User-Agent — é o conjunto de heurísticas comportamentais e de
runtime (CDP, navigator.webdriver, timing de eventos, entropia de TLS) que
**nenhuma das stealth-libs livres consegue mascarar 100%**. O CF não confia
no token Turnstile quando o "score humano" daquela sessão está abaixo do
threshold.

## Decision

**Adotar proxy residencial brasileiro como dependência obrigatória do
warm-up em produção.**

Justificativa:

1. **Score de reputação alto**: IPs residenciais ISP-BR têm reputação
   limpa no Cloudflare e elevam o human-score base da sessão antes mesmo
   do JS de detecção rodar.
2. **Rotatividade legítima**: cada warm-up novo pode usar um IP diferente,
   o que dilui a impressão digital persistente que hoje nos coloca em
   blocklist comportamental.
3. **Geo-locking**: o iFood serve apenas Brasil. Um IP BR é coerente com o
   endereço-âncora (Avenida Paulista) e com o `Accept-Language: pt-BR`.
4. **Custo previsível**: pay-as-you-go (~US$ 1.75-3.00/GB residencial BR)
   é ordens de grandeza menor que captcha-solvers comerciais quando o
   volume é moderado (warm-up consome ~5-15 MB por sessão).

### Provedor de partida: IPRoyal Residential

- Pay-as-you-go (sem mensalidade).
- Geo-targeting BR via modifier `_country-br` na senha.
- Sticky sessions de até 10 min via `_session-<X>_lifetime-10m` na senha
  (suficiente para 1 warm-up + N requisições da mesma rodada, já que
  `cf_clearance` é amarrado ao IP de origem).
- Endpoint padrão: `geo.iproyal.com:12321`.
- **Pegadinha do painel**: os dropdowns `Country` e `Rotation` da UI do
  IPRoyal são apenas defaults globais. Para que o geo-targeting e o
  sticky-session realmente funcionem, os modifiers precisam ser anexados
  à **senha** (não ao username), separados por `_`. Exemplo:
  `PROXY_PASSWORD=<senha-painel>_country-br_session-warmup1_lifetime-10m`.

Alternativas equivalentes: ProxyEmpire, SOAX, Bright Data.

### Implementação técnica

- `chrome-context.openStealthContext` aceita `proxy: { server, username,
  password, bypass }` e o repassa para `chromium.launchPersistentContext`.
- `BrowserPoolOptions` carrega `proxy` opcional, propagado no `init()`.
- CLI lê `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` do ambiente, ou
  aceita `--proxy http://user:pass@host:port`.
- **Sticky-session é mandatório durante o warm-up**: trocar de IP no meio
  do fluxo invalida o `cf_clearance` recém-emitido. Cada execução do CLI
  deve usar **um** session-id; cf-clearance dura ~30 min.

## Consequences

- ➕ Warm-up reentra no fluxo "humano" do CF: o widget Turnstile passa a
  aparecer (em vez do JS-challenge direto que vimos sem proxy). Validado
  com `session-warmup2` (IP 179.107.114.66): solver de Turnstile resolveu
  o widget na 3ª tentativa, frame sumiu.
- ➖ **O CF do iFood encadeia um segundo estágio JS-only após o Turnstile.**
  Esse estágio não tem widget, não tem iframe, não tem o que clicar.
  Depende 100% do runtime do browser passar nos checks de fingerprint
  do CF. Nem `patchright` + `ghost-cursor` + IP residencial BR sticky
  passam nele. Veja [ADR-0009](0009-capsolver-cloudflare-challenge.md).
- ➕ Caminho claro de escala horizontal quando combinado com solver:
  1 worker = 1 sticky-session = 1 IP residencial. Concorrência limitada
  por GB contratado, não por bloqueio.
- ➕ IP residencial BR é coerente com o endereço-âncora (Av. Paulista) e
  `Accept-Language: pt-BR` — elimina mismatch geo que o CF usária como
  sinal.
- ➖ IPs do pool IPRoyal range `179.125.x` (AS28321 Onnet) podem estar
  marcados pelo CF como "proxy provider suspeito" e não receber nem o
  widget Turnstile. Solução: rotacionar `session-<X>` até cair em ASN
  limpo, ou trocar de provedor (ProxyEmpire/SOAX). Confirmado: `warmup1`
  caiu em 179.125.77.128 → JS-only direto; `warmup2` caiu em 179.107.114.66
  → widget Turnstile.
- ➖ Dependência externa paga (~US$ 5-15 de crédito inicial). Operação
  precisa monitorar saldo do provedor.
- ➖ Latência adicional de 200-600 ms por requisição vs. saída direta.
  Aceitável para o caso de uso (catálogo, não real-time).
- ➖ Profile persistente (ADR-0006) deixa de ser portável: cookies
  `cf_clearance` são amarrados ao IP do warm-up. Trocar de IP exige novo
  warm-up. Mitigação: reusar o mesmo session-id sticky em rodadas
  consecutivas, ou re-warmar de manhã (`cf_clearance` expira em 30 min de
  qualquer forma).
- ⚠️ **Nunca commitar PROXY_PASSWORD**. `.env` está no `.gitignore`;
  `.env.example` documenta apenas o formato.

## Histórico de iterações (Marco 8)

| Tentativa | Config | Resultado |
| --- | --- | --- |
| 1 | IPRoyal `session-warmup1` = 179.125.77.128 | CF mandou JS-only direto (sem widget). `<iframe> elements no DOM=0`. Impossível resolver. |
| 2 | IPRoyal `session-warmup2` = 179.107.114.66 | CF mandou widget Turnstile → solver resolveu na 3ª tentativa → frame sumiu → CF re-emitiu **JS-only sem iframe** → timeout 180s. |

## Validação esperada (agora só atingida em conjunto com ADR-0009)

```bash
rm -rf /tmp/ifood-proxy
LOG_LEVEL=debug npm run dev -- \
  --input fixtures/urls-sample-3.csv \
  --output out/smoke-proxy \
  --concurrency 2 \
  --no-resume \
  --profile /tmp/ifood-proxy
```

Critério de sucesso: 3/3 URLs com `unitPriceCents` populado.

## Recomendação operacional

- Mantenha o proxy residencial **ativo** mesmo após adotar a ADR-0009: o
  CF dispara fluxos diferentes para IPs limpos (BR residencial → widget)
  vs. datacenter/sujo (JS-only direto). O solver de Cloudflare Challenge
  é mais barato e r´apido quando o desafio é o widget.
- Rotacione `session-<X>` quando observar **dois warm-ups seguidos**
  caindo em JS-only direto (sinal de que o IP atual foi marcado).
- Em produção, prefira `session-<merchantId>` para que cada merchant tenha
  affinity de IP — reduz pegada de "muitos merchants no mesmo IP" que o
  CF lê como scraping.
