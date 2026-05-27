/**
 * xhr-capture.mjs — captura de XHR da API do iFood
 *
 * Navega para uma URL de produto e aguarda a resposta da API interna do iFood,
 * retornando o status HTTP e o JSON capturado.
 */

/** Timeout máximo aguardando a API do iFood responder (ms). */
const XHR_CAPTURE_MS = 6_000

/**
 * Navega para pageUrl e aguarda a primeira resposta da API do iFood.
 * @param {import('playwright').Page} page
 * @param {string} pageUrl
 * @param {number} navTimeoutMs  timeout da navegação (page.goto)
 * @returns {Promise<{ status: number|null, json: object|null }>}
 */
export async function captureItemXhr(page, pageUrl, navTimeoutMs) {
    let capturedStatus = null
    let capturedJson = null
    let signalReady
    const ready = new Promise(r => { signalReady = r })

    const onResponse = async res => {
        const url = res.url()
        if (!url.includes('/restaurant/') || !url.includes('/items/')) return
        if (capturedJson ?.data ?.menu ?.length > 0) return // já temos dados válidos

        capturedStatus = res.status()
        if (capturedStatus === 200) {
            const j = await res.json().catch(() => null)
            if (j ?.data ?.menu ?.length > 0) capturedJson = j
        }
        signalReady()
    }

    page.on('response', onResponse)
    try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => {})
        await Promise.race([ready, new Promise(r => setTimeout(r, XHR_CAPTURE_MS))])
    } finally {
        page.off('response', onResponse)
    }

    return { status: capturedStatus, json: capturedJson }
}