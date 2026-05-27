# Relatório de Execução — Crawler iFood

> **Gerado em:** 2026-05-27T07:01:41.982Z
> **Fonte:** `/Users/alvaromachadoferreira/workspace/crawler-test-v2/data/products_output_enriched.json`

---

## Resumo Executivo

| Métrica | Valor |
|---|---|
| Total de URLs processadas | **999** |
| Produtos com preço capturado | **641** |
| Falhas | **358** |
| **Taxa de sucesso** | **64.2%** |
| Meta ≥ 95% | ❌ NÃO ATINGIDA |
| Tempo total de execução | 896m 33s |

```
Sucesso  [███████████████████░░░░░░░░░░░] 64.2%
Falha    [███████████░░░░░░░░░░░░░░░░░░░] 35.8%
```

---

## Por Grupo de Loja

| Grupo | Total | Sucesso | Falha | Taxa | Tempo |
|---|---|---|---|---|---|
| Carrefour | 368 | 228 | 140 | 62.0% | 257m 17s |
| Farmácias | 363 | 235 | 128 | 64.7% | 300m 47s |
| Pão de Açúcar | 215 | 178 | 37 | 82.8% | 338m 29s |
| Outros | 53 | 0 | 53 | 0.0% | – |

---

## Análise de Preços

| Métrica | Valor |
|---|---|
| Preço mínimo | R$ 4,63 |
| Preço máximo | R$ 301,99 |
| Preço médio | R$ 35,16 |
| Mediana de preço | R$ 23,10 |
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
| `title` | 641 / 999 | 64.2% | ██████████░░░░░ |
| `normal_price` | 641 / 999 | 64.2% | ██████████░░░░░ |
| `discount_price` | 0 / 999 | 0.0% | ░░░░░░░░░░░░░░░ |
| `image_url` | 0 / 999 | 0.0% | ░░░░░░░░░░░░░░░ |

---

## Tipos de Erro

| Mensagem | Ocorrências | % dos Erros |
|---|---|---|
| Preço não encontrado | 358 | 100.0% |

---

*Relatório gerado por `scripts/generate-report.mjs`*
