let dbPromise: Promise<IDBDatabase> | null = null

export type PageRecord = {
  loc: string
  sourceUrl: string
  lastmod?: string
  // Derived, stored for prefix search
  path: string
  // Lowercased path for case-insensitive and fuzzy matching
  path_lc?: string
}

export type SourceMeta = {
  url: string
  lastFetched: number
  expiresAt: number
  total: number
}

function pathFromLoc(loc: string): string {
  try {
    const u = new URL(loc)
    return u.pathname || "/"
  } catch {
    // If it's already a path or a non-absolute URL
    return loc.startsWith("/") ? loc : `/${loc}`
  }
}

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  // Bump version to 3 to add by_path_lc index and support backfill
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("visual-editor-db", 3)
    req.onupgradeneeded = () => {
      const db = req.result
      // Create or upgrade "pages" store
      let pages: IDBObjectStore
      if (!db.objectStoreNames.contains("pages")) {
        pages = db.createObjectStore("pages", { keyPath: "loc" })
        pages.createIndex("by_source", "sourceUrl", { unique: false })
        pages.createIndex("by_path", "path", { unique: false })
        pages.createIndex("by_path_lc", "path_lc", { unique: false })
      } else {
        // Upgrade indices if needed
        const tx = req.transaction!
        pages = tx.objectStore("pages")
        if (!pages.indexNames.contains("by_source")) {
          pages.createIndex("by_source", "sourceUrl", { unique: false })
        }
        if (!pages.indexNames.contains("by_path")) {
          pages.createIndex("by_path", "path", { unique: false })
        }
        if (!pages.indexNames.contains("by_path_lc")) {
          pages.createIndex("by_path_lc", "path_lc", { unique: false })
        }
      }
      // Create or ensure "sources" store
      if (!db.objectStoreNames.contains("sources")) {
        db.createObjectStore("sources", { keyPath: "url" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function putPagesBulk(
  sourceUrl: string,
  records: Omit<PageRecord, "path" | "path_lc">[],
  chunkSize = 2000
) {
  const db = await openDB()
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["pages"], "readwrite")
      const store = tx.objectStore("pages")
      for (const r of chunk) {
        const path = pathFromLoc(r.loc)
        const path_lc = path.toLowerCase()
        store.put({ ...r, sourceUrl, path, path_lc })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
}

export async function countBySource(sourceUrl: string): Promise<number> {
  const db = await openDB()
  return await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(["pages"], "readonly")
    const index = tx.objectStore("pages").index("by_source")
    const req = index.count(IDBKeyRange.only(sourceUrl))
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => reject(req.error)
  })
}

export async function getSampleBySource(
  sourceUrl: string,
  limit = 200,
  offset = 0
) {
  const db = await openDB()
  return await new Promise<PageRecord[]>((resolve, reject) => {
    const out: PageRecord[] = []
    let skipped = 0
    const tx = db.transaction(["pages"], "readonly")
    const index = tx.objectStore("pages").index("by_source")
    const req = index.openCursor(IDBKeyRange.only(sourceUrl))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve(out)
      if (skipped < offset) {
        skipped++
        return cursor.continue()
      }
      out.push(cursor.value as PageRecord)
      if (out.length >= limit) return resolve(out)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

function normPrefix(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return "/"
  const lead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  // Collapse multiple slashes
  return lead.replace(/\/{2,}/g, "/")
}

// Case-insensitive prefix search on path_lc
export async function searchByPathPrefixLC(prefix: string, limit = 50) {
  const db = await openDB()
  const norm = normPrefix(prefix).toLowerCase()
  const upper = norm + "\uffff"
  return await new Promise<PageRecord[]>((resolve, reject) => {
    const out: PageRecord[] = []
    const tx = db.transaction(["pages"], "readonly")
    const idx = tx.objectStore("pages").index("by_path_lc")
    const range = IDBKeyRange.bound(norm, upper, false, false)
    const req = idx.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve(out)
      out.push(cursor.value as PageRecord)
      if (out.length >= limit) return resolve(out)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

// Lightweight substring fallback: scans a capped number of entries
export async function searchBySubstringLC(substr: string, limit = 10, visitCap = 1000) {
  const db = await openDB()
  const needle = substr.trim().toLowerCase()
  if (!needle) return []
  return await new Promise<PageRecord[]>((resolve, reject) => {
    const out: PageRecord[] = []
    let visited = 0
    const tx = db.transaction(["pages"], "readonly")
    const idx = tx.objectStore("pages").index("by_path_lc")
    const req = idx.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return resolve(out)
      visited++
      const rec = cursor.value as PageRecord
      const plc = (rec.path_lc || rec.path || "").toLowerCase()
      if (plc.includes(needle)) {
        out.push(rec)
        if (out.length >= limit) return resolve(out)
      }
      if (visited >= visitCap) return resolve(out)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

// Fuzzy helper: try prefix (case-insensitive), then substring fallback
export async function searchFuzzy(raw: string, limit = 10) {
  const q = raw.trim()
  if (!q) return []
  const prefixResults = await searchByPathPrefixLC(q, limit)
  if (prefixResults.length >= limit) return prefixResults
  // Only try substring fallback when the input doesn't clearly encode a deep path prefix
  // or when prefix results are scarce.
  const fallback = await searchBySubstringLC(q, limit - prefixResults.length, 800)
  return [...prefixResults, ...fallback].slice(0, limit)
}

export async function getSource(url: string): Promise<SourceMeta | undefined> {
  const db = await openDB()
  return await new Promise<SourceMeta | undefined>((resolve, reject) => {
    const tx = db.transaction(["sources"], "readonly")
    const req = tx.objectStore("sources").get(url)
    req.onsuccess = () => resolve(req.result as SourceMeta | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function upsertSource(meta: SourceMeta) {
  const db = await openDB()
  return await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["sources"], "readwrite")
    tx.objectStore("sources").put(meta)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function getAllSources(): Promise<SourceMeta[]> {
  const db = await openDB()
  return await new Promise<SourceMeta[]>((resolve, reject) => {
    const tx = db.transaction(["sources"], "readonly")
    const req = tx.objectStore("sources").getAll()
    req.onsuccess = () => resolve((req.result as SourceMeta[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

// One-time backfill for existing records missing path/path_lc
async function backfillMissingPaths() {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["pages"], "readwrite")
    const store = tx.objectStore("pages")
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const rec = cursor.value as PageRecord
      const needsPath = !rec.path || typeof rec.path !== "string"
      const computedPath = needsPath ? pathFromLoc(rec.loc) : rec.path
      const needsPathLc = !rec.path_lc || rec.path_lc !== computedPath.toLowerCase()
      if (needsPath || needsPathLc) {
        const updated = {
          ...rec,
          path: computedPath,
          path_lc: computedPath.toLowerCase(),
        }
        cursor.update(updated)
      }
      cursor.continue()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

// Call this once on app load to ensure indices have data.
export async function ensureBackfillPathsOnce() {
  try {
    const flag = localStorage.getItem("idb:paths-backfilled:v3")
    if (flag === "true") return
    await backfillMissingPaths()
    localStorage.setItem("idb:paths-backfilled:v3", "true")
  } catch {
    // Ignore storage errors; backfill still ran (or will run again on next load)
  }
}

// Utilities exported for consumers
export const utils = { pathFromLoc }
