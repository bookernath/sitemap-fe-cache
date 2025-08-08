import { putPagesBulk, countBySource, upsertSource, type PageRecord } from "./idb"

export type ImportProgress = {
  totalSitemaps: number
  processedSitemaps: number
  urlsImported: number
  startedAt: number
}

export type ImportCallbacks = {
  onStart?: (p: ImportProgress) => void
  onProgress?: (p: ImportProgress) => void
  onBatch?: (batch: PageRecord[]) => void // for incremental UI sampling
  onComplete?: (finalCount: number) => void
  onError?: (err: Error) => void
}

export type ImportOptions = {
  // How many child sitemaps each request should include
  groupSize?: number
  // How many requests to run in parallel
  concurrency?: number
  // TTL for the cache meta
  ttlMs?: number
  // For UI sampling per batch
  samplePerBatch?: number
}

const DEFAULTS: Required<ImportOptions> = {
  groupSize: 20,
  concurrency: 4,
  ttlMs: 1000 * 60 * 60 * 6, // 6h
  samplePerBatch: 50,
}

export function importLargeSitemapIndex(url: string, callbacks: ImportCallbacks = {}, opts: ImportOptions = {}) {
  const { groupSize, concurrency, ttlMs, samplePerBatch } = { ...DEFAULTS, ...opts }

  let cancelled = false
  const aborters = new Set<AbortController>()

  async function fetchJSON(path: string, body: any, signal?: AbortSignal) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data?.error || `Request failed: ${res.status}`)
    }
    return data
  }

  async function analyze() {
    const controller = new AbortController()
    aborters.add(controller)
    try {
      const info = await fetchJSON("/api/sitemap/index", { url }, controller.signal)
      return info
    } finally {
      aborters.delete(controller)
    }
  }

  function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }

  async function processGroup(sourceUrl: string, group: string[], progress: ImportProgress) {
    if (cancelled) return
    const controller = new AbortController()
    aborters.add(controller)
    try {
      const { urls } = await fetchJSON("/api/sitemap/urls", { sitemaps: group }, controller.signal)
      const records: PageRecord[] = urls.map((u: any) => ({
        loc: u.loc,
        lastmod: u.lastmod,
        sourceUrl,
      }))
      // Write to IDB in chunks, keeping UI responsive
      await putPagesBulk(sourceUrl, records, 1000)
      progress.urlsImported += records.length
      progress.processedSitemaps += group.length
      callbacks.onBatch?.(records.slice(0, samplePerBatch))
      callbacks.onProgress?.({ ...progress })
    } finally {
      aborters.delete(controller)
    }
  }

  async function runPool(sourceUrl: string, groups: string[][], progress: ImportProgress) {
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
      while (!cancelled) {
        const idx = next++
        if (idx >= groups.length) break
        await processGroup(sourceUrl, groups[idx], progress)
      }
    })
    await Promise.all(workers)
  }

  const promise = (async () => {
    try {
      const info = await analyze()

      // If it's a simple sitemap (urlset), just reuse the existing endpoint once.
      if (info?.type === "urlset") {
        const controller = new AbortController()
        aborters.add(controller)
        try {
          const data = await fetchJSON("/api/sitemap", { url }, controller.signal)
          const records: PageRecord[] =
            (data.urls as { loc: string; lastmod?: string }[]).map((u) => ({
              loc: u.loc,
              lastmod: u.lastmod,
              sourceUrl: url,
            })) || []
          await putPagesBulk(url, records, 1000)
          const total = await countBySource(url)
          await upsertSource({
            url,
            lastFetched: Date.now(),
            expiresAt: Date.now() + ttlMs,
            total,
          })
          callbacks.onBatch?.(records.slice(0, DEFAULTS.samplePerBatch))
          callbacks.onComplete?.(total)
          return
        } finally {
          aborters.delete(controller)
        }
      }

      const sitemaps: string[] = info?.sitemaps || []
      const totalSitemaps = info?.count ?? sitemaps.length
      const groups = chunk(sitemaps, groupSize)
      const progress: ImportProgress = {
        totalSitemaps,
        processedSitemaps: 0,
        urlsImported: 0,
        startedAt: Date.now(),
      }
      callbacks.onStart?.({ ...progress })
      callbacks.onProgress?.({ ...progress })

      await runPool(url, groups, progress)

      if (cancelled) return
      const total = await countBySource(url)
      await upsertSource({
        url,
        lastFetched: Date.now(),
        expiresAt: Date.now() + ttlMs,
        total,
      })
      callbacks.onComplete?.(total)
    } catch (err: any) {
      if (!cancelled) callbacks.onError?.(err)
    }
  })()

  function cancel() {
    cancelled = true
    for (const a of aborters) {
      try {
        a.abort()
      } catch {}
    }
    aborters.clear()
  }

  return { promise, cancel }
}
