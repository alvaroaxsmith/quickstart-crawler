// Helper para abrir um BrowserContext persistente endurecido contra detecção.
//
// Centraliza a configuração compartilhada entre `scripts/_browser.ts`
// (bootstrap, capture) e `BrowserPool` (runtime do crawler) — ADR-0006 e
// ADR-0007.
//
// Implementacao atual usa **patchright** (fork do Playwright com patches
// anti-detect agressivos). Substituiu playwright-extra + stealth, que
// estava sendo detectado pelo Cloudflare Bot Management do iFood em modo
// "always-challenge" (re-emissao infinita de Turnstile).
//
// Recomendacoes oficiais do patchright (seguidas aqui):
//  - NAO usar `--disable-blink-features=AutomationControlled` (a flag em si
//    e detectavel; patchright ja lida via patch interno)
//  - NAO ignorar `--enable-automation` (mesmo motivo)
//  - NAO setar `userAgent` customizado (patchright deixa o UA real do Chrome)
//  - NAO injetar addInitScript de stealth manual
//  - Usar `channel: 'chrome'` (Chrome real, nao Chromium)
//  - Usar `launchPersistentContext` (nao `launch()`)

import { chromium as patchrightChromium } from 'patchright'
import { chromium as playwrightChromium } from 'playwright'
import type { BrowserContext } from 'playwright'

export const LAUNCH_ARGS = [
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-dev-shm-usage',
  '--start-maximized',
]

export interface ProxyConfig {
  /** Ex.: `http://br.proxy.example.com:8000` */
  server: string
  username?: string
  password?: string
  /** Bypass list (CSV). Default: `localhost,127.0.0.1` */
  bypass?: string
}

export interface OpenContextOpts {
  userDataDir: string
  headless?: boolean
  /** Proxy residencial/datacenter — ADR-0008. */
  proxy?: ProxyConfig
  /**
   * URL do Chrome DevTools Protocol de um Chrome já em execução.
   * Ex.: `http://localhost:9222`
   *
   * Quando definido, o crawler se conecta ao Chrome externo via CDP
   * em vez de lançar um novo processo. O Chrome externo não carrega
   * flags de automação, logo o CF Managed Challenge passa automaticamente.
   *
   * Para iniciar o Chrome com suporte a CDP (macOS):
   *   open -na "Google Chrome" --args \
   *     --remote-debugging-port=9222 \
   *     --user-data-dir=/tmp/chrome-cdp
   */
  cdpUrl?: string
}

export async function openStealthContext(opts: OpenContextOpts): Promise<BrowserContext> {
  // Modo CDP: conecta a um Chrome externo já em execução sem flags de automação.
  // Chrome lançado manualmente passa no CF Managed Challenge automaticamente.
  if (opts.cdpUrl) {
    const browser = await playwrightChromium.connectOverCDP(opts.cdpUrl)
    // Reutiliza o contexto padrão do Chrome externo (tem cookies reais).
    const existing = browser.contexts()
    const ctx = existing.length > 0 ? existing[0] : await browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
    })
    return ctx as unknown as BrowserContext
  }

  const ctx = await patchrightChromium.launchPersistentContext(opts.userDataDir, {
    headless: opts.headless ?? false,
    channel: 'chrome',
    args: LAUNCH_ARGS,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 2,
    hasTouch: false,
    isMobile: false,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    ...(opts.proxy
      ? {
          proxy: {
            server: opts.proxy.server,
            ...(opts.proxy.username ? { username: opts.proxy.username } : {}),
            ...(opts.proxy.password ? { password: opts.proxy.password } : {}),
            bypass: opts.proxy.bypass ?? 'localhost,127.0.0.1',
          },
        }
      : {}),
  })
  return ctx as unknown as BrowserContext
}
