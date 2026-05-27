// Port: busca o conteúdo de uma URL.
//
// Implementação primária (ADR-0007): `PlaywrightFetcher` — usa um
// `BrowserPool` para abrir uma tab, navega à URL para esquentar cookies,
// e chama via `page.request.get` o endpoint canônico do iFood
// (`/site-api/v1/merchants/{m}/items/{i}`). Devolve o JSON do item +
// HTML SSR como fallback.

export interface FetchResponse {
  /** HTML SSR retornado pelo `goto()`. Útil para fallback (productData). */
  html: string
  /**
   * Resposta crua do endpoint de item (ADR-0007). O extractor primário
   * consome este campo. `undefined` se a URL não pôde ser resolvida em
   * (merchantId, itemId) ou se a chamada falhou.
   */
  itemJson?: unknown
  /** Status HTTP do endpoint de item (200, 404, 403, ...). */
  itemStatus?: number
  /** Status HTTP do `goto()` inicial. */
  httpStatus: number
  /** Tempo total da operação (goto + item-endpoint). */
  durationMs: number
}

export interface PageFetcher {
  fetch(url: string, options: { timeoutMs: number }): Promise<FetchResponse>
}
