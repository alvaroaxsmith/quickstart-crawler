import type { Product } from './product.types.js'
import type { ParsedIfoodUrl } from './parsed-ifood-url.types.js'
import type { CrawlErrorCategory } from './errors.types.js'

// Resultado interno de processar 1 URL. Carrega o Product (saída obrigatória §4)
// + metadados úteis para logs, métricas e auditoria. parsed_url está sempre presente
// porque o parser é puro e roda antes do crawl.

export interface CrawlResult {
  product: Product
  parsed_url: ParsedIfoodUrl
  attempts: number
  duration_ms: number
  error_category?: CrawlErrorCategory
}
