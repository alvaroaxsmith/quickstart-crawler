/**
 * input — leitura e normalização de arquivos de entrada.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface UrlItem {
  merchantId: string
  itemId: string
  productUrl: string
  name?: string
}

export function defaultUrlFiles(projectRoot: string): Record<string, string> {
  return {
    pao: process.env.URL_FILE_PAO ?? resolve(projectRoot, 'data/groups/urls-pao.json'),
    carrefour:
      process.env.URL_FILE_CARREFOUR ?? resolve(projectRoot, 'data/groups/urls-carrefour.json'),
    farmacia:
      process.env.URL_FILE_FARMACIA ?? resolve(projectRoot, 'data/groups/urls-farmacia.json'),
    all: process.env.URL_FILE_ALL ?? resolve(projectRoot, 'data/groups/urls-all.json'),
  }
}

export function readUrlFile(filePath: string): UrlItem[] {
  return JSON.parse(readFileSync(filePath, 'utf8')) as UrlItem[]
}

export function loadItems(
  filePath: string,
  fromIdx = 0,
  toIdx = Infinity,
): { items: UrlItem[]; total: number } {
  const all = readUrlFile(filePath)
  const end = Number.isFinite(toIdx) ? toIdx + 1 : all.length
  return { items: all.slice(fromIdx, end), total: all.length }
}
