// Port: progresso entre execuções para suportar --resume.
// Impl hoje: FileCheckpointStore (JSON local).
// Impl futura: RedisCheckpointStore.

export interface CheckpointStore {
  load(): Promise<Set<string>>
  markProcessed(urls: string[]): Promise<void>
  filterUnprocessed(urls: string[]): Promise<string[]>
  clear(): Promise<void>
}
