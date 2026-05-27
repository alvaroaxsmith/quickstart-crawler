import { describe, it, expect } from 'vitest'
import { formatBRL, extractPrice } from '../../../src/lib/price.js'

const ITEM_ID = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: '00',
    data: {
      menu: [
        {
          itens: [
            {
              id: ITEM_ID,
              description: 'Produto Teste',
              unitPrice: 31.99,
              logoUrl: 'https://img.ifood.com.br/logo.jpg',
              ...overrides,
            },
          ],
        },
      ],
    },
  }
}

describe('formatBRL', () => {
  it('formata valor numérico em BRL', () => {
    expect(formatBRL(31.99)).toBe('R$ 31,99')
  })

  it('retorna null para null', () => {
    expect(formatBRL(null)).toBeNull()
  })

  it('retorna null para undefined', () => {
    expect(formatBRL(undefined)).toBeNull()
  })

  it('formata zero', () => {
    expect(formatBRL(0)).toBe('R$ 0,00')
  })
})

describe('extractPrice', () => {
  it('retorna nulls para json null', () => {
    const r = extractPrice(null, ITEM_ID)
    expect(r).toEqual({ normalPrice: null, discountPrice: null, title: null, logoUrl: null })
  })

  it('retorna nulls quando code !== "00"', () => {
    const r = extractPrice({ code: '01', data: {} }, ITEM_ID)
    expect(r.normalPrice).toBeNull()
  })

  it('extrai preço normal (unitPrice quando sem originalPrice)', () => {
    const r = extractPrice(makeResponse(), ITEM_ID)
    expect(r.normalPrice).toBe(31.99)
    expect(r.discountPrice).toBeNull()
    expect(r.title).toBe('Produto Teste')
    expect(r.logoUrl).toBe('https://img.ifood.com.br/logo.jpg')
  })

  it('extrai preço com desconto quando originalPrice > unitPrice', () => {
    const r = extractPrice(makeResponse({ originalPrice: 39.99, unitPrice: 31.99 }), ITEM_ID)
    expect(r.normalPrice).toBe(39.99)
    expect(r.discountPrice).toBe(31.99)
  })

  it('não marca desconto quando originalPrice === unitPrice', () => {
    const r = extractPrice(makeResponse({ originalPrice: 31.99, unitPrice: 31.99 }), ITEM_ID)
    expect(r.discountPrice).toBeNull()
  })

  it('usa fallback (primeiro item) quando itemId não corresponde', () => {
    const r = extractPrice(makeResponse(), 'outro-id-qualquer')
    expect(r.normalPrice).toBe(31.99)
  })

  it('retorna nulls quando menu está vazio', () => {
    const r = extractPrice({ code: '00', data: { menu: [] } }, ITEM_ID)
    expect(r.normalPrice).toBeNull()
  })
})
