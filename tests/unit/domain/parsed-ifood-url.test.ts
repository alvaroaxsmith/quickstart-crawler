import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  InvalidIfoodUrlError,
  parseIfoodUrl,
  tryParseIfoodUrl,
} from '../../../src/domain/parsed-ifood-url.types.js'

const REAL_DATASET = resolve(process.cwd(), 'input/urls.csv')

describe('parseIfoodUrl', () => {
  it('extrai city, merchantSlug, merchantId e itemId de URL canônica', () => {
    const url =
      'https://www.ifood.com.br/delivery/sao-paulo-sp/carrefour-hiper---pamplona-jardim-paulista/0568e774-7ba8-493c-a842-ac4d72546220?item=7c8e1d77-b8d9-40b8-a4b6-9f1893f1c2aa'
    const parsed = parseIfoodUrl(url)
    expect(parsed.city).toBe('sao-paulo-sp')
    expect(parsed.merchantSlug).toBe('carrefour-hiper---pamplona-jardim-paulista')
    expect(parsed.merchantId).toBe('0568e774-7ba8-493c-a842-ac4d72546220')
    expect(parsed.itemId).toBe('7c8e1d77-b8d9-40b8-a4b6-9f1893f1c2aa')
    expect(parsed.raw).toBe(url)
  })

  it('normaliza UUID para lowercase', () => {
    const url =
      'https://www.ifood.com.br/delivery/rj/loja/AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB?item=CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD'
    const parsed = parseIfoodUrl(url)
    expect(parsed.merchantId).toBe('aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb')
    expect(parsed.itemId).toBe('cccccccc-4444-5555-6666-dddddddddddd')
  })

  it('rejeita URL fora do padrão iFood', () => {
    expect(() => parseIfoodUrl('https://example.com/x')).toThrow(InvalidIfoodUrlError)
    expect(() => parseIfoodUrl('https://www.ifood.com.br/restaurants')).toThrow(InvalidIfoodUrlError)
    expect(() =>
      parseIfoodUrl('https://www.ifood.com.br/delivery/sp/loja/not-a-uuid?item=also-not'),
    ).toThrow(InvalidIfoodUrlError)
  })

  it('rejeita URL sem querystring item=', () => {
    expect(() =>
      parseIfoodUrl(
        'https://www.ifood.com.br/delivery/sp/loja/0568e774-7ba8-493c-a842-ac4d72546220',
      ),
    ).toThrow(InvalidIfoodUrlError)
  })

  it('tryParseIfoodUrl retorna null em vez de lançar', () => {
    expect(tryParseIfoodUrl('lixo')).toBeNull()
    expect(tryParseIfoodUrl('https://www.ifood.com.br/delivery/sp/x/uuid?item=uuid')).toBeNull()
  })

  // Property test contra o dataset real de 999 URLs
  it('parseia 100% das 999 URLs reais do dataset oficial', () => {
    const content = readFileSync(REAL_DATASET, 'utf-8')
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const header = lines.shift()
    expect(header).toBe('url')
    expect(lines).toHaveLength(999)

    const failures: string[] = []
    for (const url of lines) {
      if (tryParseIfoodUrl(url) === null) {
        failures.push(url)
      }
    }
    expect(failures).toEqual([])
  })

  it('todas as URLs reais têm merchantId e itemId como UUIDs distintos', () => {
    const content = readFileSync(REAL_DATASET, 'utf-8')
    const lines = content
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(1)
    for (const url of lines) {
      const p = parseIfoodUrl(url)
      expect(p.merchantId).not.toBe(p.itemId)
    }
  })
})
