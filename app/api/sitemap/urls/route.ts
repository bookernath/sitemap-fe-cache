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

function extractFromUrlset(xmlObj: any): UrlEntry[] {
  const urls = toArray(xmlObj?.urlset?.url)
  return urls
    .map((u: any) => {
      const loc = typeof u?.loc === "string" ? u.loc : String(u?.loc ?? "")
      if (!loc) return null
      const lastmod =
        typeof u?.lastmod === "string" ? u.lastmod : u?.lastmod ? String(u.lastmod) : undefined
      return { loc, lastmod } as UrlEntry
    })
    .filter(Boolean) as UrlEntry[]
}

export async function POST(req: Request) {
  try {
    const { sitemaps } = (await req.json()) as { sitemaps?: string[] }
    if (!Array.isArray(sitemaps) || sitemaps.length === 0) {
      return NextResponse.json({ error: "Missing sitemaps" }, { status: 400 })
    }

    const results = await Promise.allSettled(
      sitemaps.map(async (sm) => {
        const xml = await fetchXml(sm)
        const obj = parser.parse(xml)
        // If a child happens to also be an index, skip it here for simplicity.
        // The client should pass only urlset children.
        if (!obj?.urlset) return []
        return extractFromUrlset(obj)
      })
    )

    const urls: UrlEntry[] = []
    for (const r of results) {
      if (r.status === "fulfilled") urls.push(...r.value)
    }

    // Dedupe this batch
    const seen = new Set<string>()
    const deduped: UrlEntry[] = []
    for (const u of urls) {
      if (!seen.has(u.loc)) {
        seen.add(u.loc)
        deduped.push(u)
      }
    }

    return NextResponse.json({
      urls: deduped,
      counts: { sitemaps: sitemaps.length, urls: deduped.length },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 })
  }
}
