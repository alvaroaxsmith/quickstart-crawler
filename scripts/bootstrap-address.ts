// Bootstrap automatizado de sessão iFood — executado UMA VEZ.
//
// Abre Chrome real com mitigações anti-bot (ver scripts/_browser.ts) num
// PROFILE PERSISTENTE em fixtures/browser-profile/, digita o endereço-âncora,
// confirma no modal de mapa e exporta storageState. Sem etapa manual.
//
// Endereço configurável via env var ANCHOR_ADDRESS (default: Av Paulista, SP).

import { createConnection } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { openStealthContext, type ProxyConfig } from '../src/adapters/fetcher/chrome-context.service.js'
import { solveTurnstileIfPresent } from './_turnstile.service.js'

const PROFILE_DIR = process.env.PROFILE_DIR ?? 'fixtures/browser-profile'
const STORAGE_OUT = process.env.STORAGE_OUT ?? 'fixtures/storage-state.json'
const ADDRESS = process.env.ANCHOR_ADDRESS ?? 'Avenida Paulista, 1000, São Paulo'

// Tempo máximo para Cloudflare liberar (em ms).
// CF Managed Challenge pode levar até ~90s em IPs residenciais novos.
// 5 minutos dá tempo para interação humana se o CF entrar em loop.
const CF_TIMEOUT = 300_000
// Delay entre teclas para simular digitação humana.
const TYPE_DELAY = 80

/** Le PROXY_SERVER / PROXY_USERNAME / PROXY_PASSWORD do env e monta o
 *  ProxyConfig esperado pelo openStealthContext. Critico para o bootstrap:
 *  IP residencial direto do usuario tipicamente esta em "always-challenge"
 *  do CF apos varias tentativas, enquanto IP novo do proxy IPRoyal passa. */
function loadProxyFromEnv(): ProxyConfig | undefined {
  const server = process.env['PROXY_SERVER']
  if (!server) return undefined
  try {
    const u = new URL(server)
    const username = u.username || process.env['PROXY_USERNAME']
    const password = u.password
      ? decodeURIComponent(u.password)
      : process.env['PROXY_PASSWORD']
    const cfg: ProxyConfig = { server: `${u.protocol}//${u.host}` }
    if (username) cfg.username = decodeURIComponent(username)
    if (password) cfg.password = password
    return cfg
  } catch {
    throw new Error(`PROXY_SERVER invalido: ${server} (use http://host:port)`)
  }
}

/** Rotaciona o session-id no password IPRoyal para obter IP novo do pool.
 *  Formato esperado: "base_country-br_session-XXX_lifetime-Nm" */
function rotateSession(password: string): string {
  const newId = `session-auto${Date.now()}`
  if (/_session-[^_]+/.test(password)) {
    return password.replace(/_session-[^_]+/, `_session-${newId}`)
  }
  if (password.includes('_lifetime-')) {
    return password.replace('_lifetime-', `_${newId}_lifetime-`)
  }
  return `${password}_${newId}`
}

/** Testa se o proxy aceita um tunel CONNECT em ~8s.
 *  Retorna true se o proxy responder HTTP/1.1 200. */
async function testProxyConnect(
  server: string,
  username: string,
  password: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const u = new URL(server)
    const host = u.hostname
    const port = parseInt(u.port) || 3128
    const auth = Buffer.from(`${username}:${password}`).toString('base64')
    const socket = createConnection({ host, port, timeout: 8000 }, () => {
      socket.write(
        `CONNECT ipv4.icanhazip.com:443 HTTP/1.1\r\n` +
          `Host: ipv4.icanhazip.com:443\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          `\r\n`,
      )
    })
    socket.once('data', (chunk) => {
      socket.destroy()
      resolve(chunk.toString().startsWith('HTTP/1.1 200'))
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/** Verifica o proxy e rotaciona a session-id se necessário (max 3 tentativas).
 *  Muta proxy.password em caso de rotacao para que o Chrome use a nova. */
async function ensureProxyAlive(proxy: ProxyConfig): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    process.stdout.write(`▶ Testando proxy (tentativa ${attempt}/3)... `)
    const ok = await testProxyConnect(proxy.server, proxy.username ?? '', proxy.password ?? '')
    if (ok) {
      console.log('OK')
      return
    }
    console.log('504')
    if (attempt < 3) {
      proxy.password = rotateSession(proxy.password ?? '')
      const sid = proxy.password.match(/_session-[^_]+/)?.[0] ?? '?'
      console.log(`  Session expirou — nova: ${sid}`)
    }
  }
  console.error('\n✗ Proxy falhou após 3 tentativas. Verifique créditos IPRoyal.')
  process.exit(1)
}

async function main(): Promise<void> {
  await mkdir(PROFILE_DIR, { recursive: true })
  const proxy = loadProxyFromEnv()
  console.log(`▶ Profile : ${PROFILE_DIR}`)
  console.log(`▶ Endereço: ${ADDRESS}`)
  console.log(`▶ Proxy   : ${proxy ? `${proxy.server} (auth: ${proxy.username ? 'sim' : 'nao'})` : 'NENHUM (IP direto)'}`)

  if (proxy) await ensureProxyAlive(proxy)

  console.log('▶ Abrindo Chrome real com stealth-plugin...\n')

  const ctx = await openStealthContext({
    userDataDir: PROFILE_DIR,
    headless: false,
    ...(proxy ? { proxy } : {}),
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  await page.goto('https://www.ifood.com.br/', { waitUntil: 'domcontentloaded' })

  // 0. Resolver Turnstile interativo se aparecer (managed challenge do iFood,
  //    diferente do JS challenge passivo). Idempotente: se ausente, no-op.
  await solveTurnstileIfPresent(page, { verbose: true })

  // 1. Aguardar Cloudflare liberar. Concorre entre dois estados possíveis:
  //    (a) home já renderizada com endereço persistido (chip no header) → skip
  //    (b) precisa setar endereço (input grande visível)
  //
  //    USA Promise.any (não Promise.race): Promise.race rejeita na primeira falha;
  //    Promise.any só rejeita se TODAS falharem — correto aqui.
  console.log(`\u23f3 Aguardando Cloudflare liberar (timeout ${CF_TIMEOUT / 1000}s)...`)
  console.log('  ℹ️  Chrome está aberto — se aparecer captcha, resolva manualmente no Chrome.')
  console.log('  ℹ️  Se o CF entrar em loop infinito: troque para hotspot do celular e reinicie.\n')

  // Monitor de progresso: mostra o título da página a cada 15s enquanto espera.
  const cfMonitor = setInterval(async () => {
    try {
      const t = await page.title()
      if (/um momento|just a moment/i.test(t)) {
        process.stdout.write(`  [CF] Managed Challenge ativo — aguardando CF resolver...\n`)
      } else if (t && !/^\s*$/.test(t)) {
        process.stdout.write(`  [CF] Título atual: "${t}"\n`)
      }
    } catch { /* página pode estar navegando */ }
  }, 15_000)

  // Sinais de "home pronta com endereço já setado":
  //   - links específicos do iFood (hrefs internos, data-testid de nav)
  //   - IMPORTANTE: não usar [role="link"] pois o CF também tem elementos com esse papel
  const homeReady = page
    .locator(
      'a[href*="/restaurantes"], a[href*="/mercados"], a[href*="/farmacias"],'
        + ' a[href*="restaurante"], a[href*="mercado"], a[href*="farmacia"],'
        + ' [data-testid*="header-address" i], [data-testid*="nav-category" i]',
    )
    .first()

  // Sinais de "precisa setar endereço":
  //   - input grande com placeholder de endereço/CEP/localização
  const addressInput = page
    .getByPlaceholder(/endereço|endereco|onde você está|onde voc[eê] est[áa]|qual o seu endere|cep/i)
    .first()

  const winner = await Promise.any([
    homeReady.waitFor({ state: 'visible', timeout: CF_TIMEOUT }).then(() => 'ready' as const),
    addressInput
      .waitFor({ state: 'visible', timeout: CF_TIMEOUT })
      .then(() => 'needs-address' as const),
  ]).catch(async () => {
    clearInterval(cfMonitor)
    const title = await page.title().catch(() => '?')
    const url = page.url()
    throw new Error(
      `CF não liberou em ${CF_TIMEOUT / 1000}s.\n` +
        `  URL: ${url}\n` +
        `  Title: "${title}"\n` +
        `  → Tente trocar o session-id no PROXY_PASSWORD (IP pode estar marcado pelo CF).`,
    )
  })
  clearInterval(cfMonitor)

  if (winner === 'ready') {
    console.log('✓ Profile já contém endereço — nenhuma ação necessária\n')
  } else {
    console.log('✓ Cloudflare liberado, home pediu endereço\n')

    // 2. Digitar endereço com delay humano.
    console.log(`⌨  Digitando "${ADDRESS}"...`)
    await addressInput.click()
    await addressInput.fill('')
    await addressInput.pressSequentially(ADDRESS, { delay: TYPE_DELAY })

    // 3. Aguardar a primeira sugestão do dropdown de autocomplete.
    console.log('⏳ Aguardando sugestões de autocomplete...')
    const firstSuggestion = page
      .locator('[role="option"], [data-testid*="suggestion" i], li[role="listitem"] button, ul li')
      .first()
    await firstSuggestion.waitFor({ state: 'visible', timeout: 15_000 })
    await firstSuggestion.click()
    console.log('✓ Sugestão selecionada\n')

    // 4. Modal "Confirmar localização" — pode ou não aparecer.
    console.log('⏳ Aguardando modal de confirmação do mapa (opcional)...')
    const confirmBtn = page.getByRole('button', {
      name: /confirmar localização|confirmar localizacao|confirmar endere/i,
    })
    const confirmAppeared = await confirmBtn
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (confirmAppeared) {
      await confirmBtn.click()
      console.log('✓ Localização confirmada\n')
    } else {
      console.log('  (modal não apareceu — autocomplete já setou direto)\n')
    }

    // 5. Aguardar a home re-renderizar com endereço aplicado.
    // Aceita múltiplos sinais (iFood muda layout/copy frequentemente).
    console.log('⏳ Aguardando home re-renderizar...')
    const homeSignals = [
      page.getByRole('link', { name: /mercados|restaurantes|farm[áa]cias|lojas/i }).first(),
      page.getByRole('button', { name: /buscar|pesquisar/i }).first(),
      page.locator('[data-testid*="header" i], [data-testid*="address" i]').first(),
      page.getByText(/paulista/i).first(),
    ]
    const homeOk = await Promise.race(
      homeSignals.map((s) =>
        s
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => true)
          .catch(() => false),
      ),
    )
    if (homeOk) console.log('✓ Sinal de home detectado')
    else console.log('⚠ Nenhum sinal explícito de home — seguindo mesmo assim (cookies já setados)')
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
    await page.waitForTimeout(2000)
    console.log('✓ Sessão pronta\n')
  }

  // 6. Exportar storageState como backup.
  await ctx.storageState({ path: STORAGE_OUT })
  console.log(`✓ Profile persistido em ${PROFILE_DIR}/`)
  console.log(`✓ storageState (backup) salvo em ${STORAGE_OUT}\n`)

  console.log('Fechando browser em 2s...')
  await page.waitForTimeout(2000)
  await ctx.close()
  console.log('✓ Bootstrap concluído.')
}

try {
  await main()
} catch (err: unknown) {
  console.error('FATAL:', err)
  process.exit(1)
}
