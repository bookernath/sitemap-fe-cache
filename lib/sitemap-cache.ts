import { getAllSources, getSampleBySource, upsertSource, countBySource, putPagesBulk, type PageRecord, type SourceMeta, getSource } from "./idb"

export type ImportResult = {
  sample: PageRecord[]
  total: number
  meta: SourceMeta
}

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6 // 6 hours

async function fetchUrlsFromServer(url: string): Promise<PageRecord[]> {
  const res = await fetch("/api/sitemap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data?.error || "Failed to import")
  }
  const list = (data.urls as { loc: string; lastmod?: string }[]) || []
  return list.map((u) => ({ loc: u.loc, lastmod: u.lastmod, sourceUrl: url }))
}

// Import and cache fresh data; returns a small sample for UI
export async function importAndCache(url: string, ttlMs = DEFAULT_TTL_MS, sampleSize = 200): Promise<ImportResult> {
  const entries = await fetchUrlsFromServer(url)
  await putPagesBulk(url, entries)
  const total = await countBySource(url)
  const meta: SourceMeta = {
    url,
    lastFetched: Date.now(),
    expiresAt: Date.now() + ttlMs,
    total,
  }
  await upsertSource(meta)
  const sample = await getSampleBySource(url, sampleSize)
  return { sample, total, meta }
}

// Load from cache if available
export async function loadFromCache(url: string, sampleSize = 200) {
  const meta = await getSource(url)
  if (!meta) return undefined
  const sample = await getSampleBySource(url, sampleSize)
  return { sample, total: meta.total, meta }
}

// Return cached sources
export async function listSources() {
  return await getAllSources()
}

// If expired, refresh in the background; invokes onUpdated when done
export async function refreshIfExpired(url: string, onUpdated?: (r: ImportResult) => void, ttlMs = DEFAULT_TTL_MS) {
  const meta = await getSource(url)
  if (!meta) return
  if (Date.now() > meta.expiresAt) {
    importAndCache(url, ttlMs).then((r) => onUpdated?.(r)).catch(() => {
      /* swallow background errors */
    })
  }
}

// Force a refresh regardless of TTL
export async function forceRefresh(url: string, ttlMs = DEFAULT_TTL_MS, sampleSize = 200) {
  return await importAndCache(url, ttlMs, sampleSize)
}
