import { describe, expect, it } from 'vitest'
import { ConfigError, configSnapshot, loadConfig } from '../../../../src/infrastructure/config/index.js'

function envOf(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides }
}

describe('loadConfig', () => {
  it('aplica defaults quando env vazio', () => {
    const c = loadConfig(envOf())
    expect(c.inputFile).toBe('input/urls.csv')
    expect(c.outputDir).toBe('output')
    expect(c.outputFormats).toEqual(['json', 'csv'])
    expect(c.concurrency).toBe(8)
    expect(c.browserPoolSize).toBe(3)
    expect(c.maxRetries).toBe(3)
    expect(c.timeoutMs).toBe(30_000)
    expect(c.headless).toBe(true)
    expect(c.logLevel).toBe('info')
    expect(c.resume).toBe(false)
  })

  it('parseia OUTPUT_FORMATS com espaços e case mixed', () => {
    const c = loadConfig(envOf({ OUTPUT_FORMATS: ' JSON , Csv , XLSX ' }))
    expect(c.outputFormats).toEqual(['json', 'csv', 'xlsx'])
  })

  it('rejeita formato inválido', () => {
    expect(() => loadConfig(envOf({ OUTPUT_FORMATS: 'json,parquet' }))).toThrow(ConfigError)
  })

  it('rejeita OUTPUT_FORMATS vazio', () => {
    expect(() => loadConfig(envOf({ OUTPUT_FORMATS: ',,' }))).toThrow(ConfigError)
  })

  it('rejeita CONCURRENCY fora do range', () => {
    expect(() => loadConfig(envOf({ CONCURRENCY: '0' }))).toThrow(ConfigError)
    expect(() => loadConfig(envOf({ CONCURRENCY: '999' }))).toThrow(ConfigError)
    expect(() => loadConfig(envOf({ CONCURRENCY: 'abc' }))).toThrow(ConfigError)
  })

  it('rejeita DELAY_MIN > DELAY_MAX', () => {
    expect(() =>
      loadConfig(envOf({ DELAY_MIN_MS: '2000', DELAY_MAX_MS: '1000' })),
    ).toThrow(/DELAY_MIN_MS/)
  })

  it('rejeita BROWSER_POOL_SIZE > CONCURRENCY', () => {
    expect(() =>
      loadConfig(envOf({ CONCURRENCY: '2', BROWSER_POOL_SIZE: '5' })),
    ).toThrow(/BROWSER_POOL_SIZE/)
  })

  it('aceita HEADLESS=true|false|1|0', () => {
    expect(loadConfig(envOf({ HEADLESS: 'true' })).headless).toBe(true)
    expect(loadConfig(envOf({ HEADLESS: 'false' })).headless).toBe(false)
    expect(loadConfig(envOf({ HEADLESS: '1' })).headless).toBe(true)
    expect(loadConfig(envOf({ HEADLESS: '0' })).headless).toBe(false)
  })

  it('rejeita HEADLESS inválido', () => {
    expect(() => loadConfig(envOf({ HEADLESS: 'yes' }))).toThrow(ConfigError)
  })

  it('rejeita LOG_LEVEL inválido', () => {
    expect(() => loadConfig(envOf({ LOG_LEVEL: 'trace' }))).toThrow(ConfigError)
  })

  it('configSnapshot retorna apenas os 3 campos do report', () => {
    const c = loadConfig(envOf({ CONCURRENCY: '4', MAX_RETRIES: '5', TIMEOUT_MS: '10000' }))
    expect(configSnapshot(c)).toEqual({ concurrency: 4, max_retries: 5, timeout_ms: 10_000 })
  })
})
