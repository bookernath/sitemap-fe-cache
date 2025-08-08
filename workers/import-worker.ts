/// <reference lib="webworker" />
// Worker runs in its own thread; all heavy coordination and IDB writes live here.

import { XMLParser } from "fast-xml-parser"
import {
  putPagesBulk,
  countBySource,
  upsertSource,
  type PageRecord,
} from "../lib/idb"
import type {
  ImportProgress,
  ImportOptions,
  MainToWorker,
  WorkerToMain,
  WorkerStartPayload,
} from "../lib/import-types"

const DEFAULTS: Required<ImportOptions> = {
  groupSize: 20,
  concurrency: 4,
  ttlMs: 1000 * 60 * 60 * 6, // 6 hours
  samplePerBatch: 50,
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
})

let cancelled = false
const aborters = new Set<AbortController>()

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

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

async function analyze(url: string) {
  const controller = new AbortController()
  aborters.add(controller)
  try {
    // Uses server route to avoid cross-origin CORS issues and heavy XML parsing in the client.
    const info = await fetchJSON("/api/sitemap/index", { url }, controller.signal)
    return info
  } finally {
    aborters.delete(controller)
  }
}

async function processGroup(
  sourceUrl: string,
  group: string[],
  progress: ImportProgress,
  samplePerBatch: number
) {
  if (cancelled) return
  const controller = new AbortController()
  aborters.add(controller)
  try {
    // Server batches parsing of many child sitemaps.
    const { urls } = await fetchJSON("/api/sitemap/urls", { sitemaps: group }, controller.signal)
    const records: Omit<PageRecord, "path">[] = (urls as { loc: string; lastmod?: string }[]).map(
      (u) => ({ loc: u.loc, lastmod: u.lastmod, sourceUrl })
    )
    // Chunked IDB writes (off main thread)
    await putPagesBulk(sourceUrl, records, 1000)

    progress.urlsImported += records.length
    progress.processedSitemaps += group.length

    const sample = (urls as { loc: string; lastmod?: string }[]).slice(0, samplePerBatch)
    postMessage({ type: "batch", sample } satisfies WorkerToMain)
    postMessage({ type: "progress", progress } satisfies WorkerToMain)
  } finally {
    aborters.delete(controller)
  }
}

async function processUrlsetDirect(url: string, ttlMs: number) {
  // For plain sitemaps, reuse existing /api/sitemap route for parsing.
  const controller = new AbortController()
  aborters.add(controller)
  try {
    const data = await fetchJSON("/api/sitemap", { url }, controller.signal)
    const urls: { loc: string; lastmod?: string }[] = data.urls || []
    const records: Omit<PageRecord, "path">[] = urls.map((u) => ({
      loc: u.loc,
      lastmod: u.lastmod,
      sourceUrl: url,
    }))
    await putPagesBulk(url, records, 1000)
    const total = await countBySource(url)
    await upsertSource({
      url,
      lastFetched: Date.now(),
      expiresAt: Date.now() + ttlMs,
      total,
    })
    postMessage({ type: "batch", sample: urls.slice(0, DEFAULTS.samplePerBatch) } satisfies WorkerToMain)
    postMessage({ type: "complete", total } satisfies WorkerToMain)
  } finally {
    aborters.delete(controller)
  }
}

async function run(payload: WorkerStartPayload) {
  cancelled = false
  const { url, options } = payload
  const { groupSize, concurrency, ttlMs, samplePerBatch } = { ...DEFAULTS, ...options }

  try {
    const info = await analyze(url)

    // urlset: single sitemap
    if (info?.type === "urlset") {
      const p: ImportProgress = {
        totalSitemaps: 1,
        processedSitemaps: 0,
        urlsImported: 0,
        startedAt: Date.now(),
      }
      postMessage({ type: "start", progress: p } satisfies WorkerToMain)
      await processUrlsetDirect(url, ttlMs)
      return
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
    postMessage({ type: "start", progress } satisfies WorkerToMain)

    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
      while (!cancelled) {
        const idx = next++
        if (idx >= groups.length) break
        await processGroup(url, groups[idx], progress, samplePerBatch)
      }
    })
    await Promise.all(workers)

    if (cancelled) return
    const total = await countBySource(url)
    await upsertSource({
      url,
      lastFetched: Date.now(),
      expiresAt: Date.now() + ttlMs,
      total,
    })
    postMessage({ type: "complete", total } satisfies WorkerToMain)
  } catch (err: any) {
    postMessage({ type: "error", message: err?.message || "Unknown error" } satisfies WorkerToMain)
  }
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data
  if (msg.type === "start") {
    run(msg.payload)
  } else if (msg.type === "cancel") {
    cancelled = true
    for (const a of aborters) {
      try {
        a.abort()
      } catch {}
    }
    aborters.clear()
  }
}
