import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCheckpointStore } from '../../../../src/adapters/checkpoint/file-checkpoint-store.adapter.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/cp-`)
  file = join(dir, 'checkpoint.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true })
})

describe('FileCheckpointStore', () => {
  it('load() em arquivo inexistente retorna Set vazio', async () => {
    const s = new FileCheckpointStore(file)
    expect((await s.load()).size).toBe(0)
  })

  it('marca 50 URLs, recarrega e filtra 100 → restam 50', async () => {
    const s1 = new FileCheckpointStore(file)
    const processed = Array.from({ length: 50 }, (_, i) => `https://x/${i}`)
    await s1.markProcessed(processed)

    const s2 = new FileCheckpointStore(file)
    const all = Array.from({ length: 100 }, (_, i) => `https://x/${i}`)
    const remaining = await s2.filterUnprocessed(all)
    expect(remaining).toHaveLength(50)
    expect(remaining[0]).toBe('https://x/50')
  })

  it('markProcessed é idempotente (Set dedupe)', async () => {
    const s = new FileCheckpointStore(file)
    await s.markProcessed(['a', 'b'])
    await s.markProcessed(['b', 'c'])
    const loaded = await new FileCheckpointStore(file).load()
    expect(loaded.size).toBe(3)
  })

  it('clear() apaga o arquivo e o Set interno', async () => {
    const s = new FileCheckpointStore(file)
    await s.markProcessed(['a'])
    await s.clear()
    expect((await new FileCheckpointStore(file).load()).size).toBe(0)
  })
})
