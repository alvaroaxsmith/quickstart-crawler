# ADR-0011 — Modo manual é o caminho default; solvers remotos são opt-in

## Status

Aceita — 25/05/2026. Substitui o tom de "obrigatório em produção" das ADRs
0008/0009/0010.

## Contexto

Ao longo do desenvolvimento adotamos três dependências externas como
"obrigatórias em produção" para vencer o Cloudflare Bot Management do
iFood:

- **ADR-0008** — proxy residencial BR (pago).
- **ADR-0009** — CapSolver `AntiCloudflareTask` (pago).
- **ADR-0010** — FlareSolverr (gratuito, mas com taxa de sucesso baixa).

Smoke tests reais (Marco 5–10) mostraram que:

1. **O estágio 2 do CF do iFood é Managed Challenge JS-only**: zero
   iframes, apenas JS rodando checks de fingerprint contra TLS, canvas,
   WebGL, áudio, timezone e comportamento de mouse/teclado.
2. **Não existe bypass técnico gratuito confiável em 2026** para esse
   estágio. CapSolver/2Captcha/AntiCaptcha cobram justamente porque a
   solução envolve infra de Chrome real + farms de fingerprint
   rotativas — caro de manter.
3. **FlareSolverr** funciona em sites com CF "padrão" mas falha em
   ~50-70 % das tentativas contra o BM enterprise que o iFood usa.
4. **Avaliação do case técnico** explicitamente valoriza tratamento de
   erros, registro estruturado e categorização de falhas (§6.3, §14)
   além da taxa de sucesso bruta (§5.5, peso 20 %).

Decisão original ("exigir proxy + solver pago em produção") tornou o
projeto **não-reproduzível** sem cartão de crédito do avaliador, o que
viola o §10 do case ("não pode entregar solução que não possa ser
reproduzida pelo avaliador").

## Decisão

**Modo manual com profile persistente é o caminho default** do crawler.
Solvers remotos (CapSolver, FlareSolverr) e proxy residencial continuam
**implementados e plugáveis via env vars**, mas tornam-se *opt-in*:

```text
SEM env vars de solver/proxy:
  → crawler usa fixtures/browser-profile/ (warm-up local + Turnstile)
  → requer 1 execução manual de scripts/bootstrap-address.ts a cada
    ~30 min para revalidar cf_clearance
  → taxa esperada: 50-80 % na janela ativa

COM CAPSOLVER_API_KEY + PROXY_SERVER:
  → re-warm automático em background
  → taxa esperada: 85-95 %
  → custo: ~US$ 0,80 por 1 000 challenges + ~US$ 1,75/GB de proxy

COM FLARESOLVERR_URL (sem custo):
  → re-warm automático mas instável
  → taxa esperada: 30-50 %
```

### Mudanças concretas

- **README**: novo banner explicando os três modos com taxa esperada
  honesta para cada. Quickstart prioriza o modo manual. Modo
  automatizado vira "Quickstart 2".
- **Tabela de env vars**: coluna "obrigatório em produção" trocada por
  duas colunas ("modo manual" / "modo automatizado") deixando claro que
  o modo manual não exige nenhuma env paga.
- **Troubleshooting**: passos do modo manual aparecem primeiro em cada
  sintoma; passos do modo automatizado entram como alternativa.
- **CLI**: nenhuma mudança necessária — a lógica de fallback ("se solver
  setado, usa; senão warm-up local") já estava implementada nas
  ADRs 0008-0010.

## Consequências

- ➕ **Reproduzibilidade**: avaliador clona o repo, instala deps, roda
  `bootstrap-address.ts`, vê dados sendo extraídos. Sem cartão.
- ➕ **Honestidade da entrega**: a documentação descreve a realidade
  técnica de 2026 em vez de prometer 95 % universal. Isso é mais valioso
  para a avaliação (§6.3, §14, §13 "limitações conhecidas").
- ➕ **Hexagonal preservada**: a porta `CloudflareSolver` continua
  intacta. Quem quiser pode plugar Capmonster, 2Captcha, ou solver
  próprio criando um adapter novo.
- ➖ **Taxa de sucesso bruta cai** no modo default (50-80 % por janela
  vs 95 % almejado pelo case §5.5). Mitigação: `--resume` + re-bootstrap
  permitem múltiplas passadas até atingir cobertura cumulativa alta.
- ➖ **Requer atenção humana** a cada ~30 min. Aceitável para avaliação
  de 1 000 URLs (~3-4 ciclos manuais), inaceitável para produção 24×7
  — que é o caso de uso onde os solvers pagos passam a justificar custo.

## Evidências esperadas na entrega

Para alinhar com §7.3 do case ("Evidências de Execução"):

- `out/run-*/products.json` com mistura de `status:'success'` e
  `status:'error'` com `error_message` legível.
- `out/run-*/execution_report.json` com `errors_by_category` exibindo
  `BLOCKED: <N>` quando o estágio 2 disparar durante a execução.
- `logs/run-*.log` (estruturado JSON) com evento `warm-up: falhou` na
  expiração do `cf_clearance`, sinalizando ao avaliador o ponto correto
  de re-bootstrap.
- README "Limitações conhecidas" listando explicitamente esse trade-off.

## Trabalho futuro

- **Auto re-warm com bootstrap headful**: detectar `cf_clearance`
  expirado dentro do crawler e disparar nova janela do Chrome
  automaticamente (ainda exige clique humano, mas evita re-rodar CLI).
- **Adapter composite** (já planejado em ADR-0010): FlareSolverr como
  primário, CapSolver como fallback. Reduz custo em ~70 %.
- **Avaliar Camoufox / Patchright build customizada**: alguns testes
  públicos em 2026 mostram bypass de CF BM com builds Firefox-based
  patcheadas. Risco alto; reavaliar daqui a 1 ciclo.
