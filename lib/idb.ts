let dbPromise: Promise<IDBDatabase> | null = null

export type PageRecord = {
  loc: string
  sourceUrl: string
  lastmod?: string
}

export type SourceMeta = {
  url: string
  lastFetched: number
  expiresAt: number
  total: number
}

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("visual-editor-db", 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains("pages")) {
        const pages = db.createObjectStore("pages", { keyPath: "loc" })
        pages.createIndex("by_source", "sourceUrl", { unique: false })
      }
      if (!db.objectStoreNames.contains("sources")) {
        db.createObjectStore("sources", { keyPath: "url" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function putPagesBulk(sourceUrl: string, records: PageRecord[], chunkSize = 2000) {
  const db = await openDB()
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["pages"], "readwrite")
      const store = tx.objectStore("pages")
      for (const r of chunk) {
        store.put({ ...r, sourceUrl })
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
): Promise<PageRecord[]> {
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
