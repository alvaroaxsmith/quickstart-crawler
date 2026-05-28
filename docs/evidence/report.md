# Relatório de Execução — Crawler iFood

> **Gerado em:** 2026-05-27T21:20:39.883Z
> **Fonte:** `/Users/alvaromachadoferreira/workspace/crawler-test-v2/data/products_output_enriched.json`

---

## Resumo Executivo

| Métrica | Valor |
|---|---|
| Total de URLs processadas | **999** |
| Produtos com preço capturado | **560** |
| Falhas | **439** |
| **Taxa de sucesso** | **56.1%** |
| Meta ≥ 95% | ❌ NÃO ATINGIDA |
| Tempo total de execução | 3468m 55s |

```
Sucesso  [█████████████████░░░░░░░░░░░░░] 56.1%
Falha    [█████████████░░░░░░░░░░░░░░░░░] 43.9%
```

---

## Por Grupo de Loja

| Grupo | Total | Sucesso | Falha | Taxa | Tempo |
|---|---|---|---|---|---|
| Carrefour | 368 | 201 | 167 | 54.6% | 1115m 54s |
| Farmácias | 363 | 225 | 138 | 62.0% | 1161m 37s |
| Pão de Açúcar | 215 | 134 | 81 | 62.3% | 1191m 24s |
| Outros | 53 | 0 | 53 | 0.0% | – |

---

## Análise de Preços

| Métrica | Valor |
|---|---|
| Preço mínimo | R$ 4,71 |
| Preço máximo | R$ 301,99 |
| Preço médio | R$ 36,65 |
| Mediana de preço | R$ 25,95 |
| Produtos com desconto | 0 (0.0%) |
| Desconto médio | – |

### Amostra de Produtos com Desconto

| Produto | Preço Normal | Preço Desconto | Economia |
|---|---|---|---|
| – | – | – | – |

---

## Cobertura de Campos

| Campo | Preenchido | % | Cobertura |
|---|---|---|---|
| `title` | 560 / 999 | 56.1% | ████████░░░░░░░ |
| `normal_price` | 560 / 999 | 56.1% | ████████░░░░░░░ |
| `discount_price` | 0 / 999 | 0.0% | ░░░░░░░░░░░░░░░ |
| `image_url` | 560 / 999 | 56.1% | ████████░░░░░░░ |

---

## Tipos de Erro

| Mensagem | Ocorrências | % dos Erros |
|---|---|---|
| UNAVAILABLE: produto indisponível (fora da área de entrega ou bloqueio temporário) | 386 | 87.9% |
| DEACTIVATED: loja desativada no iFood (URL inativa) | 53 | 12.1% |

---

*Relatório gerado por `scripts/generate-report.mjs`*
