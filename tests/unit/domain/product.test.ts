import { describe, expect, it } from 'vitest'
import { createErrorProduct, createSuccessProduct } from '../../../src/domain/product.types.js'

describe('Product factories', () => {
  it('createSuccessProduct define status success e error_message null', () => {
    const p = createSuccessProduct({
      title: 'Coca-Cola 2L',
      normal_price: 'R$ 12,90',
      discount_price: 'R$ 9,90',
      product_url: 'https://www.ifood.com.br/x',
      image_url: 'https://img/x.png',
    })
    expect(p.status).toBe('success')
    expect(p.error_message).toBeNull()
    expect(p.title).toBe('Coca-Cola 2L')
    expect(p.discount_price).toBe('R$ 9,90')
  })

  it('createErrorProduct define status error e zera os campos', () => {
    const p = createErrorProduct({
      product_url: 'https://www.ifood.com.br/y',
      error_message: 'Timeout ao carregar a página (>30s)',
    })
    expect(p.status).toBe('error')
    expect(p.title).toBeNull()
    expect(p.normal_price).toBeNull()
    expect(p.discount_price).toBeNull()
    expect(p.image_url).toBeNull()
    expect(p.error_message).toBe('Timeout ao carregar a página (>30s)')
    expect(p.product_url).toBe('https://www.ifood.com.br/y')
  })

  it('preserva todos os 7 campos obrigatórios (§4)', () => {
    const p = createSuccessProduct({
      title: 't',
      normal_price: null,
      discount_price: null,
      product_url: 'u',
      image_url: null,
    })
    const keys = Object.keys(p).sort()
    expect(keys).toEqual([
      'discount_price',
      'error_message',
      'image_url',
      'normal_price',
      'product_url',
      'status',
      'title',
    ])
  })
})
