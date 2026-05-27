import { describe, expect, it } from 'vitest'
import { createLogger } from '../../../../src/infrastructure/logger/index.js'

function makeCapture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (l) => lines.push(l) }
}

const FIXED_NOW = (): Date => new Date('2026-05-24T12:00:00.000Z')

describe('createLogger', () => {
  it('emite JSON com timestamp, level, msg e campos extras', () => {
    const cap = makeCapture()
    const log = createLogger({ level: 'info', pretty: false, write: cap.write, now: FIXED_NOW })
    log.info('hello', { foo: 1, bar: 'x' })
    expect(cap.lines).toHaveLength(1)
    const parsed = JSON.parse(cap.lines[0]!)
    expect(parsed).toEqual({
      timestamp: '2026-05-24T12:00:00.000Z',
      level: 'info',
      msg: 'hello',
      foo: 1,
      bar: 'x',
    })
  })

  it('filtra mensagens abaixo do nível configurado', () => {
    const cap = makeCapture()
    const log = createLogger({ level: 'warn', pretty: false, write: cap.write, now: FIXED_NOW })
    log.debug('skip')
    log.info('skip')
    log.warn('keep')
    log.error('keep')
    expect(cap.lines).toHaveLength(2)
    expect(JSON.parse(cap.lines[0]!).msg).toBe('keep')
    expect(JSON.parse(cap.lines[1]!).level).toBe('error')
  })

  it('child() acumula bindings e os mescla na saída', () => {
    const cap = makeCapture()
    const log = createLogger({ level: 'info', pretty: false, write: cap.write, now: FIXED_NOW })
    const child = log.child({ worker: 1 })
    const grandchild = child.child({ url: 'https://x' })
    grandchild.info('done', { duration_ms: 100 })
    const parsed = JSON.parse(cap.lines[0]!)
    expect(parsed.worker).toBe(1)
    expect(parsed.url).toBe('https://x')
    expect(parsed.duration_ms).toBe(100)
  })

  it('fields passados na chamada sobrescrevem bindings', () => {
    const cap = makeCapture()
    const log = createLogger({
      level: 'info',
      pretty: false,
      bindings: { context: 'A' },
      write: cap.write,
      now: FIXED_NOW,
    })
    log.info('m', { context: 'B' })
    expect(JSON.parse(cap.lines[0]!).context).toBe('B')
  })

  it('pretty=true emite formato legível com ANSI', () => {
    const cap = makeCapture()
    const log = createLogger({ level: 'info', pretty: true, write: cap.write, now: FIXED_NOW })
    log.info('hello', { foo: 1 })
    expect(cap.lines[0]).toContain('INFO')
    expect(cap.lines[0]).toContain('hello')
    expect(cap.lines[0]).toContain('"foo":1')
    expect(cap.lines[0]).toContain('\x1b[')
  })
})
