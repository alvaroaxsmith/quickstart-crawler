// Mantido por compat com scripts existentes. A configuração real vive em
// src/adapters/fetcher/chrome-context.ts (compartilhada com o BrowserPool).

export { openStealthContext } from '../src/adapters/fetcher/chrome-context.service.js'
export type { OpenContextOpts } from '../src/adapters/fetcher/chrome-context.service.js'

// User-Agent preservado para scripts que possam referenciar (não usado pelo
// launcher — Chrome real expõe o UA nativo, consistente com seu TLS).
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
