# Composite Result Sink para output multi-formato

O case §13 (diferenciais) menciona múltiplos formatos de saída (JSON, CSV, XLSX, SQLite).
O `CrawlProductsUseCase` poderia iterar sobre os formatos diretamente (`for (const fmt of formats)`),
mas isso acopla o use case à lógica de despacho de formatos.

Usamos o padrão Composite: `CompositeResultSink` implementa `ResultSink` e delega em paralelo
(`Promise.allSettled`) para todos os sinks habilitados. O use case não sabe quantos ou quais
sinks estão ativos — recebe sempre um único `ResultSink`.

Benefícios concretos:
- O use case fica idêntico com 1 ou 4 formatos habilitados.
- Erros de escrita em um sink (ex: XLSX com dados malformados) não bloqueiam os demais.
- Adicionar um 5º formato é criar um novo arquivo em `adapters/storage/` + registrar no `main.ts`.

## Considered Options

- **Iteração direta no use case**: Mais simples (sem classe Composite), mas acopla
  `CrawlProductsUseCase` aos tipos de sink. Qualquer novo formato exige mudar o use case.
- **Event emitter por produto**: Cada Product emitido como evento, sinks são listeners.
  Overkill para um script CLI — complexidade sem benefício real de desacoplamento.

## Consequences

- `CompositeResultSink` usa `Promise.allSettled` — uma falha de escrita em um sink é logada
  mas não aborta os demais. O `CrawlProductsUseCase` recebe um resultado consolidado.
- O buffer de Products é mantido em memória até o final da execução antes de ser escrito
  (exceto SQLite que pode receber writes incrementais). Para 999 URLs, o array de Products
  em memória é ~500KB — aceitável.
