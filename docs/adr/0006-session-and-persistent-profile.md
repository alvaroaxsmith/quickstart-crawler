# Sessão obrigatória com endereço-âncora via profile persistente

## Context

Durante a captura de fixtures (Marco 5, ver `docs/journey.md`), descobrimos
empiricamente que o iFood **não renderiza dados de produto** sem um endereço
configurado na sessão do navegador. Especificamente:

- O SSR (`__NEXT_DATA__`) entrega apenas metadata fria — sem preço.
- A API client-side de catálogo só é disparada após hydration + endereço setado.
- Sem endereço, a UI exibe modal "Tivemos um problema por aqui".

Adicionalmente, o iFood é protegido por Cloudflare. Um Chromium "limpo" do Playwright
(sem persistência de cookies, fingerprint padrão de automação) é desafiado a cada
navegação. A solução clássica `chromium.launch + newContext + storageState` falha
por dois motivos: (a) o storageState perde cache + IndexedDB + timing fingerprint;
(b) Cloudflare detecta o `navigator.webdriver` e flags default.

**Marco 5b (revisão):** mesmo com `launchPersistentContext` + stealth init script
+ flags anti-automation, o **Chromium open-source** do Playwright continuou
bloqueado por Cloudflare (loop infinito de challenge). O TLS fingerprint do
Chromium difere do Chrome real em handshake order e cipher suites — Cloudflare
identifica isso. Subimos o degrau: passamos a usar o **Google Chrome instalado
no host** via `channel: 'chrome'`.

**Marco 5c (revisão 2):** Chrome real + stealth manual *também* falhou no
Cloudflare Turnstile (loop de "confirme que você é humano"). Causa provável:
detecção via leaks de CDP (Chrome DevTools Protocol) que o Playwright usa para
controlar o browser. Adotamos `playwright-extra` + `puppeteer-extra-plugin-stealth`
(≈17 patches contra detecção, incluindo CDP leaks). Trade-off aceito: subimos de
2 para 4 deps de runtime, violando parcialmente ADR-0001 — documentado como
exceção operacional indispensável.

## Decision

Adotamos **profile de browser persistente** como pré-requisito operacional do crawler:

0. **Pré-requisito de host:** Google Chrome instalado em `/Applications/`
   (`brew install --cask google-chrome` no macOS). O Chromium do Playwright
   sozinho não passa o Cloudflare do iFood.

1. **B0 (manual, 1x):** desenvolvedor roda `scripts/bootstrap-address.ts`, que
   abre **Google Chrome real** endurecido (`channel: 'chrome'` + flags
   anti-automation + stealth init script) em
   `chromium.launchPersistentContext('fixtures/browser-profile/')`. Endereço-âncora
   é setado manualmente (Av Paulista 1000, SP — boa cobertura de mercados).

2. **Runtime:** todo `BrowserContext` do crawler é criado via o mesmo
   `launchPersistentContext('fixtures/browser-profile/')` (helper compartilhado em
   `scripts/_browser.ts`, replicado em `src/adapters/fetcher/browser-pool.ts`).
   Cookies (`cf_clearance`, endereço), localStorage, cache e fingerprint são
   reutilizados — Cloudflare libera profiles "aquecidos" sem challenge.

3. **Categoria de erro nova:** `OUT_OF_DELIVERY_AREA` adicionada em
   `CrawlErrorCategory`. Não-transiente, não-retentável. Aplicada quando o iFood
   exibe modal "não entrega aqui" ou quando a API de catálogo não é chamada após
   o timeout de hydration.

4. **Backup:** `fixtures/storage-state.json` é exportado durante o bootstrap como
   fallback caso o profile persistente seja perdido — permite reidratar parcialmente.

## Considered Options

| Opção | Decisão | Motivo |
|---|---|---|
| A) Cookies/localStorage hardcoded SP | ❌ | Frágil; Cloudflare não passa só com cookie; difícil manter |
| B) CEP por cidade da URL | ❌ futuro | Boa ideia, exige tabela cidade→CEP-âncora e setup por cidade; deixar como melhoria |
| C) storageState manual 1x | ❌ | Funciona, mas perde cache e Cloudflare desafia novamente |
| D) Profile persistente com Chromium do Playwright | ❌ (testado, falhou) | TLS fingerprint do Chromium open-source é detectado pelo Cloudflare |
| D') Profile persistente com Chrome real (`channel: 'chrome'`) sem stealth-plugin | ❌ (testado, falhou) | Leaks de CDP detectados pelo Cloudflare Turnstile — loop infinito |
| **D'') Chrome real + `playwright-extra` + stealth-plugin + profile persistente** | ✅ | Cobre CDP leaks + TLS fingerprint + sessão aquecida |
| E) Captura 100% manual via DevTools | ❌ | Não escala para 1k URLs |
| F) Conexão via CDP attach (Chrome aberto manualmente) | 🟡 plano B | Funciona, mas exige ritual manual a cada execução; mantém como fallback se stealth-plugin quebrar |

## Consequences

**Positivas:**
- Cloudflare deixa de ser bloqueador recorrente.
- Endereço setado uma vez serve todas as execuções subsequentes.
- A sessão "aquecida" reduz BLOCKED em workloads grandes.

**Negativas / Trade-offs aceitos:**
- O crawler **deixa de ser stateless**. Setup manual de ~1min é pré-requisito.
- Algumas URLs (lojas que não entregam no endereço-âncora) retornam `OUT_OF_DELIVERY_AREA`.
  A métrica de sucesso (≥ 95%) passa a ser avaliada sobre URLs cobertas pelo endereço,
  ou OUT_OF_DELIVERY_AREA é tratado como sucesso de roteamento (produto identificado,
  loja confirmada, preço indisponível por razão conhecida).
- O profile precisa ser versionado fora do Git (`.gitignore` em `fixtures/browser-profile/`).
- Em ambiente CI, o profile não existe — testes de integração com URLs reais ficam
  marcados `RUN_INTEGRATION=1` e são opt-in.

**Mitigações:**
- README documenta o setup manual no passo de "Pré-requisitos".
- `bootstrap-address.ts` é idempotente — pode ser rodado de novo se o profile for invalidado.
- O `_browser.ts` helper centraliza stealth, evitando divergência entre bootstrap e runtime.
