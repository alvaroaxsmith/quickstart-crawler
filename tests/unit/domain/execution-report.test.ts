import { describe, expect, it } from 'vitest'
import { emptyErrorsByCategory } from '../../../src/domain/execution-report.types.js'

describe('emptyErrorsByCategory', () => {
  it('inicia todas as 9 categorias em zero', () => {
    const r = emptyErrorsByCategory()
    expect(r).toEqual({
      TIMEOUT: 0,
      HTTP_ERROR: 0,
      NOT_FOUND: 0,
      BLOCKED: 0,
      INVALID_URL: 0,
      PARSE_FAILURE: 0,
      NETWORK_ERROR: 0,
      OUT_OF_DELIVERY_AREA: 0,
      UNKNOWN: 0,
    })
  })

  it('produz instâncias independentes (não compartilha referência)', () => {
    const a = emptyErrorsByCategory()
    const b = emptyErrorsByCategory()
    a.TIMEOUT = 5
    expect(b.TIMEOUT).toBe(0)
  })
})
