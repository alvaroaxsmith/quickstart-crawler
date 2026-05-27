import { describe, expect, it } from 'vitest'
import { CrawlError, isTransient, TRANSIENT_CATEGORIES } from '../../../src/domain/errors.types.js'

describe('Errors', () => {
  it('isTransient identifica categorias com retry', () => {
    expect(isTransient('TIMEOUT')).toBe(true)
    expect(isTransient('NETWORK_ERROR')).toBe(true)
    expect(isTransient('HTTP_ERROR')).toBe(true)
    expect(isTransient('BLOCKED')).toBe(true)
  })

  it('isTransient identifica categorias permanentes', () => {
    expect(isTransient('NOT_FOUND')).toBe(false)
    expect(isTransient('INVALID_URL')).toBe(false)
    expect(isTransient('PARSE_FAILURE')).toBe(false)
    expect(isTransient('UNKNOWN')).toBe(false)
  })

  it('TRANSIENT_CATEGORIES tem exatamente 4 itens', () => {
    expect(TRANSIENT_CATEGORIES.size).toBe(4)
  })

  it('CrawlError preserva categoria e gera mensagem com detalhe', () => {
    const e = new CrawlError('TIMEOUT', 'aguardando seletor')
    expect(e.category).toBe('TIMEOUT')
    expect(e.message).toContain('Timeout')
    expect(e.message).toContain('aguardando seletor')
    expect(e.name).toBe('CrawlError')
  })

  it('CrawlError sem detalhe usa mensagem base', () => {
    const e = new CrawlError('NOT_FOUND')
    expect(e.message).toBe('Produto indisponível ou removido (404)')
  })
})
