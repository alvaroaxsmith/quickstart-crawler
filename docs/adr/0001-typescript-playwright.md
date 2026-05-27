# TypeScript + Node.js 20 + Playwright em vez de Python + Scrapy

O case exige browser headless para páginas SPA React do iFood. Python + Scrapy é o stack padrão
de scraping mas não renderiza JavaScript nativamente — exigiria Scrapy-Playwright ou Selenium,
adicionando fricção e overhead de setup. TypeScript + Playwright oferece suporte TypeScript
first-class, `page.route()` para interceptação de rede (estratégia primária deste projeto),
e API consistente para browser automation. Node.js 20 LTS é o runtime com melhor integração
do Playwright e tooling (vitest, ts-node) sem overhead de transpilação em dev.

## Considered Options

- **Python + Scrapy + scrapy-playwright**: Ecossistema de scraping mais maduro, mas sem
  tipagem estática nativa e API de interceptação de rede menos ergonômica.
- **Python + Playwright**: Mesma capacidade técnica, mas perde tipagem + vitest + integração
  natural com o ecossistema Node do projeto.
- **Node.js + Puppeteer**: Alternativa a Playwright, mas sem suporte a `page.route()` para
  interceptação de respostas — inviabiliza a estratégia primária.

## Consequences

- Lock-in em Chromium (via Playwright) para todos os ambientes de execução, incluindo Docker.
  `npx playwright install chromium` é um passo obrigatório no setup.
- TypeScript strict mode force disciplina de tipos mas adiciona ~5min de setup inicial.
