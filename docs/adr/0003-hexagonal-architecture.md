# Arquitetura hexagonal para um script CLI

Um script CLI de uso único poderia ser escrito como um único arquivo com funções aninhadas.
Escolhemos arquitetura hexagonal (ports & adapters) por duas razões concretas:

1. **Testabilidade real sem browser**: Com ports como interfaces TypeScript, cada adapter pode
   ser mockado em testes unitários. `PlaywrightFetcher` é substituído por um `MockFetcher`
   que retorna HTML/JSON de fixture. Sem a camada de ports, testar o extrator exigiria um
   browser real — tornando os testes lentos e dependentes de rede.

2. **Avaliação do código é um critério explícito (§6.1, §6.2 do case)**: O avaliador verifica
   qualidade arquitetural. Um script flat não demonstraria os padrões pedidos.

O custo é real: ~1 dia extra de estrutura antes de qualquer Crawl funcionar. Justificável pelo
requisito de cobertura de testes ≥ 80% em componentes core e pelo critério "Qualidade e
organização do código" (15% da nota).

## Considered Options

- **Script flat (src/main.ts único)**: Mais rápido para um protótipo, zero boilerplate.
  Inviabiliza testes unitários sem browser e não demonstra os padrões pedidos no case.
- **Camadas simples sem ports (sem interfaces)**: Módulos separados mas acoplados às
  implementações concretas. Intermediário — mas o case pede explicitamente desacoplamento.

## Consequences

- `src/application/ports/*.ts` define contratos que devem ser mantidos consistentes com
  as implementações em `src/adapters/`. Qualquer mudança de assinatura exige atualização
  em ambos os lados.
- A composition root em `src/main.ts` instancia todos os adapters e injeta nos use cases.
  É o único lugar com conhecimento de todas as dependências concretas.
