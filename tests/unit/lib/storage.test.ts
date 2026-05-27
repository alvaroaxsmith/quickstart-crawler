import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadResults,
  saveResults,
  mergeAndSave,
  type ResultsCache,
} from '../../../src/lib/storage.js'

const MERCHANT = '5938ca36-c5ee-455b-b0ce-8211f1921be5'
const ITEM = 'c2296a33-6a72-415b-888b-9c9ed1b5b5fd'
const VALID_URL = `https://www.ifood.com.br/delivery/brasilia-df/slug/${MERCHANT}?item=${ITEM}`
const DEACT_URL = `https://www.ifood.com.br/delivery/sao-paulo-sp/desativada-loja/b06518dd-4c48-4e0e-8f19-277baaa0772f?item=${ITEM}`

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'storage-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadResults', () => {
  it('retorna objeto vazio para arquivo inexistente', () => {
    expect(loadResults(join(tmpDir, 'nao-existe.json'))).toEqual({})
  })

  it('carrega cache existente', () => {
    const file = join(tmpDir, 'cache.json')
    const data: ResultsCache = {
      [`${MERCHANT}:${ITEM}`]: {
        merchantId: MERCHANT,
        itemId: ITEM,
        normalPrice: 31.99,
        discountPrice: null,
        title: 'Produto',
        logoUrl: null,
      },
    }
    writeFileSync(file, JSON.stringify(data))
    expect(loadResults(file)).toEqual(data)
  })
})

describe('saveResults + loadResults roundtrip', () => {
  it('persiste e recupera resultados', () => {
    const file = join(tmpDir, 'results.json')
    const data: ResultsCache = {
      [`${MERCHANT}:${ITEM}`]: {
        merchantId: MERCHANT,
        itemId: ITEM,
        normalPrice: 15.5,
        discountPrice: null,
        title: 'X',
        logoUrl: null,
      },
    }
    saveResults(file, data)
    expect(loadResults(file)).toEqual(data)
  })
})

describe('mergeAndSave', () => {
  function writeOriginal(products: object[]) {
    const file = join(tmpDir, 'original.json')
    writeFileSync(file, JSON.stringify(products))
    return file
  }

  it('marca UNAVAILABLE quando produto não está no cache', () => {
    const originalFile = writeOriginal([{ product_url: VALID_URL, title: '' }])
    const outFile = join(tmpDir, 'out.json')
    const { mergedCount } = mergeAndSave(originalFile, {}, outFile)

    const out = JSON.parse(require('node:fs').readFileSync(outFile, 'utf8'))
    expect(mergedCount).toBe(0)
    expect(out[0].status).toBe('error')
    expect(out[0].error_message).toContain('UNAVAILABLE')
  })

  it('marca DEACTIVATED para URL com "desativada" no slug', () => {
    const originalFile = writeOriginal([{ product_url: DEACT_URL, title: '' }])
    const outFile = join(tmpDir, 'out.json')
    mergeAndSave(originalFile, {}, outFile)

    const out = JSON.parse(require('node:fs').readFileSync(outFile, 'utf8'))
    expect(out[0].error_message).toContain('DEACTIVATED')
  })

  it('enriquece produto com preço do cache', () => {
    const originalFile = writeOriginal([{ product_url: VALID_URL, title: '' }])
    const outFile = join(tmpDir, 'out.json')
    const cache: ResultsCache = {
      [`${MERCHANT}:${ITEM}`]: {
        merchantId: MERCHANT,
        itemId: ITEM,
        normalPrice: 31.99,
        discountPrice: null,
        title: 'Desengordurante Veja',
        logoUrl: null,
      },
    }
    const { mergedCount } = mergeAndSave(originalFile, cache, outFile)

    const out = JSON.parse(require('node:fs').readFileSync(outFile, 'utf8'))
    expect(mergedCount).toBe(1)
    expect(out[0].status).toBe('success')
    expect(out[0].normal_price).toBe('R$ 31,99')
    expect(out[0].title).toBe('Desengordurante Veja')
    expect(out[0].error_message).toBeNull()
  })

  it('enriquece com discount_price quando há promoção', () => {
    const originalFile = writeOriginal([{ product_url: VALID_URL, title: '' }])
    const outFile = join(tmpDir, 'out.json')
    const cache: ResultsCache = {
      [`${MERCHANT}:${ITEM}`]: {
        merchantId: MERCHANT,
        itemId: ITEM,
        normalPrice: 39.99,
        discountPrice: 31.99,
        title: 'Produto',
        logoUrl: null,
      },
    }
    mergeAndSave(originalFile, cache, outFile)

    const out = JSON.parse(require('node:fs').readFileSync(outFile, 'utf8'))
    expect(out[0].normal_price).toBe('R$ 39,99')
    expect(out[0].discount_price).toBe('R$ 31,99')
  })
})
