# ADR-0009 — CapSolver para Cloudflare interstitial JS-only

## Status

Aceita — Marco 9 (segue ADR-0008).

## Contexto

O Marco 8 (proxy residencial IPRoyal BR sticky) confirmou que o
Cloudflare do iFood opera em **dois estágios** quando recebe tráfego
automatizado:

1. **Estágio 1 — Turnstile widget.** Iframe `challenges.cloudflare.com`
   visível com o "Verifique que você é humano". Resolvemos localmente
   com [`turnstile.ts`](../../src/adapters/fetcher/turnstile.ts) (clique
   humanizado via `ghost-cursor-playwright`). Funciona quando o IP é
   residencial BR limpo (ADR-0008).
2. **Estágio 2 — Managed Challenge JS-only.** Página com title `Um
   momento…`, **zero iframes** no DOM, apenas JavaScript do CF rodando
   checks de fingerprint. Não há nada para clicar. O `cf_clearance` só
   é emitido se o runtime do browser passar nos checks (`navigator.*`,
   canvas, WebGL, timing, ...). Mesmo com `patchright` + `ghost-cursor`
   + proxy residencial BR sticky, o estágio 2 **bloqueia 100% das
   tentativas** (smoke 25-mai-2026, 2 sessões IPRoyal testadas).

Sem resolver o estágio 2 o warm-up falha, o `cf_clearance` nunca é
emitido, e o item-endpoint retorna 403. Solver dedicado a Cloudflare
interstitial é a única saída sem reescrever um runtime de browser que
passe nos checks do CF (caminho que demanda equipe dedicada).

## Decisão

Adotar **CapSolver** (`https://capsolver.com`) como solver remoto do
estágio 2, via task **`AntiCloudflareTask`**.

Plugar no fluxo de warm-up existente como **fallback do solver local**:

- Estágio 1 (widget Turnstile) → continua resolvido localmente.
- Estágio 2 (JS-only, sem iframe) → delega ao CapSolver, que devolve
  o cookie `cf_clearance` + o User-Agent que usou. Injetamos via
  `BrowserContext.addCookies()` e fazemos `page.reload()`.

CapSolver foi escolhido sobre 2Captcha/AntiCaptcha por:

- **Especialização em CF**: `AntiCloudflareTask` é primário, não um
  add-on. Taxa de sucesso pública ~85-95% em interstitials.
- **Custo**: US$ 0,80 / 1.000 challenges (vs. US$ 2-3 nos concorrentes).
- **Latência**: 5-15 s típico vs. 20-40 s nos concorrentes.
- **API estável**: `createTask` + `getTaskResult` (polling), bem
  documentada, suporta proxy.

### Configuração de credenciais

Via env var:

```bash
CAPSOLVER_API_KEY=CAP-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A chave é lida em [`src/cli/index.ts`](../../src/cli/index.ts) e
opcional — quando ausente, o warm-up continua tentando apenas com o
solver local (compatibilidade reversa).

### Amarração IP + UA

⚠️ **Restrição crítica do CF**: o `cf_clearance` é amarrado ao **IP** +
**User-Agent** que resolveram o challenge. Para o cookie ser aceito no
browser:

1. O CapSolver **deve** resolver pelo mesmo IP do browser. Por isso a
   integração reenvia automaticamente `PROXY_SERVER` + credenciais ao
   CapSolver como campo `proxy` da task (formato
   `http://user:pass@host:port`).
2. O CapSolver devolve o `userAgent` que usou. Se for diferente do UA
   atual da página, o CF invalida o cookie — o callsite usa o UA do
   próprio browser (`navigator.userAgent`) na request do solver, e o
   CapSolver respeita.

Combinação obrigatória em produção:

| Componente | Provedor | Função |
| --- | --- | --- |
| Browser stealth | patchright + ghost-cursor (ADR-0007) | Reduz score CF |
| IP residencial BR sticky | IPRoyal (ADR-0008) | Geo + reputação |
| Solver estágio 1 | turnstile.ts local | Resolve widget |
| Solver estágio 2 | CapSolver `AntiCloudflareTask` (este ADR) | Resolve JS-only |

## Implementação

- [`src/adapters/fetcher/capsolver-cloudflare.ts`](../../src/adapters/fetcher/capsolver-cloudflare.ts):
  novo adapter. Exporta `createCapSolverCloudflareSolver(config)` que
  retorna um `CloudflareSolver` (porta utilitária definida no
  `session-warmer.ts`).
- [`src/adapters/fetcher/session-warmer.ts`](../../src/adapters/fetcher/session-warmer.ts):
  watcher detecta `title=/momento|verifica|seguranc/` + `iframeCount=0`
  e delega ao `cloudflareSolver` quando configurado. Injeta cookies +
  `page.reload()` + segue o fluxo normal de endereço.
- [`src/cli/index.ts`](../../src/cli/index.ts): lê `CAPSOLVER_API_KEY`,
  monta solver, monta proxy URL completa, passa via `ensureWarmed`.

## Consequences

- ➕ Cobre o caso real de produção iFood (CF 2-stage).
- ➕ Custo previsível: 1 warm-up = 1 solve = US$ 0,0008. 1000 rodadas =
  US$ 0,80. Crédito inicial de US$ 5 cobre ~6.250 warm-ups.
- ➕ Opcional: ausência de `CAPSOLVER_API_KEY` cai no fluxo Marco 8
  (não quebra cenários de desenvolvimento ou de sites sem estágio 2).
- ➕ Não acopla o restante do crawler — solver é uma porta utilitária
  (`CloudflareSolver`) injetada no warm-up. Trocar de provedor exige
  apenas um novo adapter.
- ➖ Dependência externa paga com cobrança em USD. Monitorar saldo
  (CapSolver tem webhook `low-balance`).
- ➖ Latência adicional de 5-15 s no warm-up. Aceitável (warm-up é 1x
  por rodada do crawler).
- ➖ Provedor pode degradar: taxa de sucesso varia com a frequência
  com que o CF atualiza fingerprints. Mitigação: instrumentar métrica
  `warmup_capsolver_success_rate` e alarmar quando < 70 %.
- ⚠️ **Nunca commitar `CAPSOLVER_API_KEY`**. `.env` está no
  `.gitignore`; `.env.example` documenta o formato.

## Validação esperada

```bash
# Após cadastrar em capsolver.com e creditar US$ 5+:
echo 'CAPSOLVER_API_KEY=CAP-...' >> .env

rm -rf /tmp/ifood-capsolver
LOG_LEVEL=debug npm run dev -- \
  --input fixtures/urls-sample-3.csv \
  --output out/smoke-capsolver \
  --concurrency 2 \
  --no-resume \
  --profile /tmp/ifood-capsolver
```

Critério de sucesso: 3/3 URLs com `unitPriceCents` populado. Log deve
conter `capsolver: resolvido` + `solver remoto resolveu (N cookie(s))`.

## Alternativas consideradas

- **2Captcha `CF Turnstile Bypass`**: 2,5x mais caro, latência 2-3x
  maior, sem task específica para interstitial JS-only.
- **CapMonster Cloud `TurnstileTaskProxyless`**: só resolve widget,
  não interstitial.
- **Reescrever runtime para passar no estágio 2**: meses de
  engenharia, manutenção contínua. Inviável.
- **Stagehand / nstbrowser / outros browsers stealth comerciais**:
  US$ 50-200/mês mínimo, lock-in, sem garantia de cobrir o estágio 2
  do CF do iFood especificamente.
