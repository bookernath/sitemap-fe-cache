import { NextResponse } from "next/server"
import { XMLParser } from "fast-xml-parser"

type UrlEntry = { loc: string; lastmod?: string }

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
})

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`)
  }
  return await res.text()
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function extractFromUrlset(obj: any): UrlEntry[] {
  // obj.urlset.url can be an object or array
  const urls = toArray(obj?.urlset?.url)
  return urls
    .map((u: any) => {
      const loc = typeof u?.loc === "string" ? u.loc : String(u?.loc)
      if (!loc) return null
      const lastmod =
        typeof u?.lastmod === "string" ? u.lastmod : u?.lastmod ? String(u.lastmod) : undefined
      return { loc, lastmod } as UrlEntry
    })
    .filter(Boolean) as UrlEntry[]
}

async function extractFromSitemapIndex(obj: any, limit = 20): Promise<UrlEntry[]> {
  // Fetch first N child sitemaps to keep things snappy in the demo
  const sitemaps = toArray(obj?.sitemapindex?.sitemap)
  const locs: string[] = sitemaps
    .map((s: any) => (typeof s?.loc === "string" ? s.loc : String(s?.loc)))
    .filter(Boolean)
    .slice(0, limit)

  const results = await Promise.allSettled(
    locs.map(async (loc) => {
      const xml = await fetchXml(loc)
      const child = parser.parse(xml)
      return extractFromUrlset(child)
    })
  )

  const merged: UrlEntry[] = []
  for (const r of results) {
    if (r.status === "fulfilled") {
      merged.push(...r.value)
    }
  }
  return merged
}

export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url?: string }
    if (!url) {
      return NextResponse.json({ error: "Missing url" }, { status: 400 })
    }

    // Basic URL validation
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 })
    }

    const xml = await fetchXml(parsed.toString())
    const obj = parser.parse(xml)

    let entries: UrlEntry[] = []
    if (obj?.urlset) {
      entries = extractFromUrlset(obj)
    } else if (obj?.sitemapindex) {
      entries = await extractFromSitemapIndex(obj)
    } else {
      return NextResponse.json({ error: "Unrecognized sitemap format" }, { status: 422 })
    }

    // Dedupe by loc and cap total for demo
    const seen = new Set<string>()
    const urls: UrlEntry[] = []
    for (const e of entries) {
      if (!seen.has(e.loc)) {
        seen.add(e.loc)
        urls.push(e)
      }
      if (urls.length >= 500) break
    }

    return NextResponse.json({ urls })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 })
  }
}
