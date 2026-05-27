// Categorias de erro do crawl. Cada categoria mapeia para mensagem human-readable
// em error_message do Product. Retry só para categorias transitórias (ver retry-with-backoff).

export type CrawlErrorCategory =
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'NOT_FOUND'
  | 'BLOCKED'
  | 'INVALID_URL'
  | 'PARSE_FAILURE'
  | 'NETWORK_ERROR'
  | 'OUT_OF_DELIVERY_AREA'
  | 'UNKNOWN'

export const ERROR_MESSAGES: Record<CrawlErrorCategory, string> = {
  TIMEOUT: 'Timeout ao carregar a página (>30s)',
  HTTP_ERROR: 'Servidor retornou erro HTTP',
  NOT_FOUND: 'Produto indisponível ou removido (404)',
  BLOCKED: 'Acesso bloqueado pelo servidor (CAPTCHA/429)',
  INVALID_URL: 'URL malformada ou não pertence ao iFood',
  PARSE_FAILURE: 'Estrutura da página não reconhecida',
  NETWORK_ERROR: 'Falha de rede após tentativas',
  OUT_OF_DELIVERY_AREA: 'Loja não entrega no endereço-âncora configurado',
  UNKNOWN: 'Erro inesperado',
}

export const TRANSIENT_CATEGORIES: ReadonlySet<CrawlErrorCategory> = new Set<CrawlErrorCategory>([
  'TIMEOUT',
  'NETWORK_ERROR',
  'HTTP_ERROR',
  'BLOCKED',
])

export function isTransient(category: CrawlErrorCategory): boolean {
  return TRANSIENT_CATEGORIES.has(category)
}

export class CrawlError extends Error {
  readonly category: CrawlErrorCategory

  constructor(category: CrawlErrorCategory, detail?: string) {
    const base = ERROR_MESSAGES[category]
    super(detail ? `${base}: ${detail}` : base)
    this.name = 'CrawlError'
    this.category = category
  }
}
