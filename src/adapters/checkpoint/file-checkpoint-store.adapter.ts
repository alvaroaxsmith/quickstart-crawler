// FileCheckpointStore — persiste Set<url> processadas em JSON local.
// Suporta --resume: filtra URLs já feitas e ignora-as na próxima execução.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CheckpointStore } from '../../application/ports/checkpoint-store.port.js'

export class FileCheckpointStore implements CheckpointStore {
  private processed = new Set<string>()
  private loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        this.processed = new Set(arr as string[])
      }
    } catch (err) {
      // ENOENT é normal: primeira execução, sem checkpoint.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.loaded = true
    return new Set(this.processed)
  }

  async markProcessed(urls: string[]): Promise<void> {
    if (!this.loaded) await this.load()
    for (const u of urls) this.processed.add(u)
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify([...this.processed]), 'utf-8')
  }

  async filterUnprocessed(urls: string[]): Promise<string[]> {
    if (!this.loaded) await this.load()
    return urls.filter((u) => !this.processed.has(u))
  }

  async clear(): Promise<void> {
    this.processed.clear()
    try {
      await unlink(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}
