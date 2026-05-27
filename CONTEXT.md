# Crawler de Produtos iFood

Um script CLI que processa um lote de URLs públicas do iFood, extrai dados estruturados de cada
produto e persiste os resultados em um ou mais formatos de saída — gerando evidências mensuráveis
de taxa de sucesso para avaliação técnica.

> **Modo default = manual + profile persistente (ADR-0011).** O crawler **não
> exige serviços pagos**. O caminho padrão usa `scripts/bootstrap-address.ts`
> para abrir Chrome real uma vez, resolver Cloudflare manualmente, setar
> endereço-âncora e persistir o profile. O `cf_clearance` dura ~30 min — basta
> re-rodar o bootstrap quando expirar e continuar com `--resume`.
>
> **Modo automatizado (opt-in, ADR-0008 + ADR-0009 ou ADR-0010)**: se houver
> proxy residencial BR + solver remoto (CapSolver pago ou FlareSolverr
> gratuito self-hosted) configurados via env vars, o warm-up se torna
> automático e a taxa de sucesso bruta sobe de ~50-80 % para ~85-95 %.
>
> Ver detalhes operacionais em [README.md](README.md#quickstart--modo-manual-sem-custo).

---

## Language

**Product**:
A entidade central do domínio — representa os dados de um item iFood extraídos com sucesso ou
a falha registrada na tentativa. Sempre presente no output, independente de sucesso ou erro.
_Avoid_: Item (termo interno do iFood, visível na URL `?item=uuid`), Produto (evitar mistura de idiomas no código), Result (ambíguo).

**URL Batch**:
O conjunto completo de URLs lido da fonte de entrada (CSV, JSON, TXT ou XLSX) no início de uma
execução. Vira a `UrlQueue` depois do filtro de checkpoint.
_Avoid_: URL list, task list, input.

**Crawl**:
A unidade atômica de trabalho: navegar até uma URL → extrair um `Product` → registrar métricas.
Um Crawl produz exatamente um `CrawlResult`. Falhar é um resultado válido de um Crawl.
_Avoid_: Scrape (muito genérico), Request (muito baixo nível), Job.

**Fetch**:
O passo interno de um Crawl responsável por carregar a URL via Playwright e capturar o conteúdo
bruto: HTML, JSON interceptado da API interna do iFood, status HTTP e duração.
Fetch não interpreta dados — só os coleta.
_Avoid_: Download, navigate, load.

**Extract**:
O passo interno de um Crawl que transforma o conteúdo bruto de um Fetch em um `Product`.
Existem dois extratores: o primário (API JSON) e o fallback (DOM).
_Avoid_: Parse (termo genérico de programação), scrape, decode.

**Execution Report**:
O artefato JSON gerado ao final de uma execução completa, contendo total de URLs, taxa de sucesso,
distribuição de latência (p50/p95/p99), erros por categoria e snapshot da configuração usada.
É a evidência principal entregue ao avaliador.
_Avoid_: Summary (existe também o `execution_summary.md` — são documentos distintos), Stats, Report.

**Checkpoint**:
Um snapshot persistido dos identificadores de URL concluídos, gravado incrementalmente a cada
N Crawls. Permite retomar uma execução interrompida via `--resume`, pulando URLs já processadas.
O Checkpoint não armazena os dados extraídos — apenas quais URLs foram concluídas.
_Avoid_: Progress file, state file, cache.

**Result Sink**:
Um destino de persistência que recebe `Product[]` ao final de cada lote. Implementações concretas:
JSON, CSV, XLSX, SQLite. O `CompositeResultSink` grava em paralelo em todos os sinks habilitados.
_Avoid_: Writer, Exporter, Storage.

**URL Source**:
O adaptador de entrada que lê o URL Batch de um arquivo e retorna `string[]`.
Implementações concretas: `CsvUrlSource`, `JsonUrlSource`, `TxtUrlSource`, `XlsxUrlSource`.
_Avoid_: Reader, FileReader, InputAdapter.

**Circuit Breaker**:
O contador embutido na `UrlQueue` que pausa todos os workers por 60s quando 20 Crawls
consecutivos resultam em `BLOCKED`. Previne um burst de requisições fúteis durante bloqueio ativo.
O Circuit Breaker não é um componente separado — é comportamento da `UrlQueue`.
_Avoid_: Rate limiter (esse é o delay aleatório por worker), throttle, DDoS protection.

**BLOCKED**:
Uma categoria de erro de Crawl que indica que o sistema anti-bot do iFood (Cloudflare / CAPTCHA)
rejeitou a requisição antes de servir qualquer dado de produto. Distinto de:
- `TIMEOUT` — servidor demorou além do limite configurado
- `HTTP_ERROR` — servidor respondeu com código de erro (5xx)
- `NOT_FOUND` — produto removido ou URL inválida (404)
_Avoid_: Banned, rejected, rate-limited (todos imprecisos).

---

## Flagged Ambiguities

**"Item" vs "Product"**:
iFood usa o termo "item" em suas URLs (`?item=uuid`) e possivelmente em sua API interna.
Neste projeto usamos "Product" como termo do domínio. Ao mapear campos da API iFood → `Product`,
o campo será referido sempre como `Product.title`, mesmo que o campo na API seja `item.name`.
_Resolução_: "Product" é o nosso termo. "Item" aparece somente em comentários que referenciam
a API do iFood diretamente.

**Preço como string vs number**:
`Product.normal_price` e `Product.discount_price` são `string | null` (ex: `"R$ 39,90"`).
A API do iFood retorna preços como número (ex: `3990` = centavos ou `39.90` = float).
A conversão de número → string formatada acontece em `ifood-api-extractor.ts`.
_Resolução_: O domínio armazena string formatada para fidelidade ao dado exibido. Conversão é
responsabilidade do extrator, não do domínio.

---

## Example Dialogue

> **Dev**: Quando um Crawl falha com TIMEOUT, ele gera um Product?
>
> **Domínio**: Sim. Todo Crawl gera exactamente um `CrawlResult` que contém um `Product`.
> Quando o status é `'error'`, o Product tem `title: null` e `error_message` preenchido
> com a descrição da categoria de erro.
>
> **Dev**: E o Checkpoint salva esse URL de erro?
>
> **Domínio**: Sim, se `MAX_RETRIES` foram esgotadas. O Checkpoint marca a URL como
> "concluída" — independente do resultado. A taxa de sucesso é calculada no Execution Report,
> não no Checkpoint.
>
> **Dev**: Se eu usar `--resume`, o `products_output.json` da execução anterior é sobrescrito?
>
> **Domínio**: Sim. O `--resume` pula os Crawls, não os writes. A execução com `--resume`
> grava somente os Products das URLs ainda não processadas. O output final contém apenas
> os produtos dessa execução parcial. Para consolidar runs múltiplos, use o SQLite sink
> que acumula por run, ou faça merge manual dos JSONs.
