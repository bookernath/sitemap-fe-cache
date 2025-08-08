export type ImportProgress = {
  totalSitemaps: number
  processedSitemaps: number
  urlsImported: number
  startedAt: number
}

export type ImportOptions = {
  groupSize?: number
  concurrency?: number
  ttlMs?: number
  samplePerBatch?: number
}

export type WorkerStartPayload = {
  url: string
  options?: ImportOptions
}

export type WorkerToMain =
  | { type: "start"; progress: ImportProgress }
  | { type: "progress"; progress: ImportProgress }
  | { type: "batch"; sample: { loc: string; lastmod?: string }[] }
  | { type: "complete"; total: number }
  | { type: "error"; message: string }

export type MainToWorker =
  | { type: "start"; payload: WorkerStartPayload }
  | { type: "cancel" }
