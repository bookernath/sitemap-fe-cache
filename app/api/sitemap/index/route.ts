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
  const urls = toArray(obj?.urlset?.url)
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
    const { url } = (await req.json()) as { url?: string }
    if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 })

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 })
    }

    const xml = await fetchXml(parsed.toString())
    const obj = parser.parse(xml)

    if (obj?.urlset) {
      const urls = extractFromUrlset(obj)
      return NextResponse.json({ type: "urlset", urls })
    }

    if (obj?.sitemapindex) {
      const sitemaps = toArray(obj?.sitemapindex?.sitemap)
      const locs: string[] = sitemaps
        .map((s: any) => (typeof s?.loc === "string" ? s.loc : String(s?.loc ?? "")))
        .filter(Boolean)
      return NextResponse.json({ type: "index", sitemaps: locs, count: locs.length })
    }

    return NextResponse.json({ error: "Unrecognized sitemap format" }, { status: 422 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Unknown error" }, { status: 500 })
  }
}
