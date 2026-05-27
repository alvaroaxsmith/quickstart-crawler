// Port: origem de URLs a serem processadas. Implementações: CsvUrlSource,
// JsonUrlSource, TxtUrlSource, XlsxUrlSource (futuras: HttpUrlSource, KafkaUrlSource).

export interface UrlSource {
  load(): Promise<string[]>
}
