"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useToast } from "@/hooks/use-toast"
import { Progress } from "@/components/ui/progress"
import { BadgeCheck, ChevronDown, Dot, FileText, HelpCircle, ImageIcon, Laptop, Menu, Monitor, MousePointer, Plus, Search, Settings, Smartphone, Tablet, Type, Loader2, LinkIcon, RefreshCcw, Square, Play } from 'lucide-react'
import { cn } from "@/lib/utils"
import type { SourceMeta } from "@/lib/idb"
import { forceRefresh, listSources, loadFromCache, refreshIfExpired } from "@/lib/sitemap-cache"
import { ensureBackfillPathsOnce, searchFuzzy, type PageRecord } from "@/lib/idb"
import type { ImportProgress, WorkerToMain } from "@/lib/import-types"

type Device = "desktop" | "tablet" | "mobile"

type PageMeta = {
  id: string
  name: string
  path: string
  online: boolean
  title: string
  description: string
  exclude: boolean
  canonicalUrl?: string
  priority: number
  lastmod?: string
}

const initialPages: PageMeta[] = [
  {
    id: "1",
    name: "Home",
    path: "/",
    online: true,
    title: "Discover what's new",
    description: "Shop our latest arrivals and find something fresh and exciting for your home.",
    exclude: false,
    canonicalUrl: "https://example.com/",
    priority: 0.75,
  },
  {
    id: "2",
    name: "Blog list",
    path: "/blog",
    online: true,
    title: "Insights and stories",
    description: "Read the latest from our team and community.",
    exclude: false,
    canonicalUrl: "https://example.com/blog",
    priority: 0.6,
  },
  {
    id: "3",
    name: "Login",
    path: "/login",
    online: true,
    title: "Welcome back",
    description: "Sign in to manage your account and orders.",
    exclude: false,
    canonicalUrl: "https://example.com/login",
    priority: 0.2,
  },
]

function prettyNameFromPath(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Home"
  const last = pathname.split("/").filter(Boolean).pop() || "page"
  return decodeURIComponent(last).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function Page() {
  const { toast } = useToast()
  const [pages, setPages] = useState<PageMeta[]>(initialPages)
  const [selectedPageId, setSelectedPageId] = useState<string>(initialPages[0].id)
  const [device, setDevice] = useState<Device>("desktop")
  const [showReference, setShowReference] = useState(false)

  // Sitemap import / cache
  const [importUrl, setImportUrl] = useState(
    "https://cornerstone-light-demo.mybigcommerce.com/xmlsitemap.php"
  )
  const [isImporting, setIsImporting] = useState(false)
  const [activeSource, setActiveSource] = useState<SourceMeta | null>(null)
  const [sources, setSources] = useState<SourceMeta[]>([])

  // Worker-driven import progress
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const workerRef = useRef<Worker | null>(null)

  // Sidebar search (IndexedDB-only)
  const [sidebarQuery, setSidebarQuery] = useState("")
  const sidebarSearchToken = useRef(0)
  const omniSearchToken = useRef(0)
  const [sidebarResults, setSidebarResults] = useState<PageRecord[] | null>(null)

  // Omnibar quicksearch (relative path prefix)
  const [omnibarInput, setOmnibarInput] = useState("")
  const [omniResults, setOmniResults] = useState<PageRecord[]>([])
  const [showOmniResults, setShowOmniResults] = useState(false)

  const selected = useMemo(() => pages.find((p) => p.id === selectedPageId) ?? pages[0], [
    pages,
    selectedPageId,
  ])

  function updateSelected<K extends keyof PageMeta>(key: K, value: PageMeta[K]) {
    setPages((prev) => prev.map((p) => (p.id === selectedPageId ? { ...p, [key]: value } : p)))
  }

  function addPage() {
    const id = Math.random().toString(36).slice(2, 8)
    const newPage: PageMeta = {
      id,
      name: "New page",
      path: `/${id}`,
      online: false,
      title: "New page",
      description: "Describe this page...",
      exclude: true,
      canonicalUrl: "",
      priority: 0.5,
    }
    setPages((prev) => [...prev, newPage])
    setSelectedPageId(id)
  }

  function mergeSampleIntoUI(sample: { loc: string; lastmod?: string }[]) {
    setPages((prev) => {
      const existingPaths = new Set(prev.map((p) => p.path))
      const additions: PageMeta[] = []
      for (const s of sample) {
        let path = "/"
        try {
          const u = new URL(s.loc)
          path = u.pathname || "/"
        } catch {
          path = s.loc.startsWith("/") ? s.loc : `/${s.loc}`
        }
        if (!existingPaths.has(path)) {
          const id = Math.random().toString(36).slice(2, 10)
          additions.push({
            id,
            name: prettyNameFromPath(path),
            path,
            online: true,
            title: prettyNameFromPath(path),
            description: "",
            exclude: false,
            canonicalUrl: s.loc,
            priority: 0.5,
            lastmod: s.lastmod,
          })
          existingPaths.add(path)
        }
      }
      return [...prev, ...additions]
    })
  }

  function ensurePageFromRecord(rec: PageRecord) {
    const effectivePath = rec.path || (() => {
      try {
        const u = new URL(rec.loc)
        return u.pathname || "/"
      } catch {
        return rec.loc.startsWith("/") ? rec.loc : `/${rec.loc}`
      }
    })()
    setPages((prev) => {
      const found = prev.find((p) => p.path === effectivePath)
      if (found) {
        setSelectedPageId(found.id)
        return prev
      }
      const id = Math.random().toString(36).slice(2, 10)
      const next: PageMeta = {
        id,
        name: prettyNameFromPath(effectivePath),
        path: effectivePath,
        online: true,
        title: prettyNameFromPath(effectivePath),
        description: "",
        exclude: false,
        canonicalUrl: rec.loc,
        priority: 0.5,
        lastmod: rec.lastmod,
      }
      setSelectedPageId(id)
      return [...prev, next]
    })
  }

  // One-time: ensure backfill of path/path_lc so searches work on old data.
  useEffect(() => {
    ;(async () => {
      await ensureBackfillPathsOnce()
    })()
  }, [])

  // Cached-first, then silent refresh if expired
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const all = await listSources()
      if (cancelled) return
      setSources(all)
      const cached = await loadFromCache(importUrl)
      if (cancelled) return
      if (cached) {
        setActiveSource(cached.meta)
        mergeSampleIntoUI(cached.sample)
        await refreshIfExpired(importUrl, (r) => {
          if (cancelled) return
          setActiveSource(r.meta)
          mergeSampleIntoUI(r.sample)
          setSources((prev) => {
            const others = prev.filter((s) => s.url !== r.meta.url)
            return [...others, r.meta]
          })
          toast({ title: "Background update", description: "Sitemap cache refreshed." })
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sidebar live search (IDB-only, fuzzy)
  useEffect(() => {
    let active = true
    const token = ++sidebarSearchToken.current
    ;(async () => {
      const q = sidebarQuery.trim()
      if (!q) {
        if (active) setSidebarResults(null)
        return
      }
      try {
        const results = await searchFuzzy(q, 10)
        if (!active || sidebarSearchToken.current !== token) return
        setSidebarResults(results)
      } catch {
        if (active) setSidebarResults([])
      }
    })()
    return () => {
      active = false
    }
  }, [sidebarQuery])

  // Omnibar quicksearch (across all sources, fuzzy for relative paths)
  useEffect(() => {
    let mounted = true
    const token = ++omniSearchToken.current
    ;(async () => {
      const q = omnibarInput
      const looksLikePath = q.trim().startsWith("/") || !q.includes("://")
      if (!looksLikePath) {
        if (mounted) {
          setOmniResults([])
          setShowOmniResults(false)
        }
        return
      }
      const results = await searchFuzzy(q.trim(), 10)
      if (!mounted || omniSearchToken.current !== token) return
      setOmniResults(results)
      setShowOmniResults(results.length > 0)
    })()
    return () => {
      mounted = false
    }
  }, [omnibarInput])

  function getWorker(): Worker {
    if (workerRef.current) return workerRef.current
    const w = new Worker(new URL("../workers/import-worker.ts", import.meta.url), { type: "module" })
    w.onmessage = (e: MessageEvent<WorkerToMain>) => {
      const msg = e.data
      if (msg.type === "start") {
        setProgress(msg.progress)
        setIsImporting(true)
      } else if (msg.type === "progress") {
        setProgress(msg.progress)
      } else if (msg.type === "batch") {
        mergeSampleIntoUI(msg.sample.slice(0, 20))
      } else if (msg.type === "complete") {
        setIsImporting(false)
        setProgress(null)
        setActiveSource({
          url: importUrl,
          lastFetched: Date.now(),
          expiresAt: Date.now() + 1000 * 60 * 60 * 6,
          total: msg.total,
        })
        ;(async () => setSources(await listSources()))()
        toast({ title: "Import complete", description: `Cached ${msg.total.toLocaleString()} URLs.` })
      } else if (msg.type === "error") {
        setIsImporting(false)
        setProgress(null)
        toast({ title: "Import failed", description: msg.message, variant: "destructive" })
      }
    }
    workerRef.current = w
    return w
  }

  async function startImportWithWorker(url: string) {
    setIsImporting(true)
    setProgress(null)
    const w = getWorker()
    w.postMessage({ type: "start", payload: { url, options: { groupSize: 20, concurrency: 4 } } })
  }

  function cancelImport() {
    workerRef.current?.postMessage({ type: "cancel" })
    setIsImporting(false)
    setProgress(null)
    toast({
      title: "Import canceled",
      description: "You can resume by clicking Import again.",
    })
  }

  async function refreshSimple(url: string, silent = false) {
    setIsImporting(true)
    try {
      const res = await forceRefresh(url)
      setActiveSource(res.meta)
      mergeSampleIntoUI(res.sample)
      setSources(await listSources())
      if (!silent) {
        toast({
          title: "Sitemap refreshed",
          description: `Cached ${res.total.toLocaleString()} URLs.`,
        })
      }
    } catch (err: any) {
      toast({
        title: "Refresh failed",
        description: err.message ?? "Unknown error",
        variant: "destructive",
      })
    } finally {
      setIsImporting(false)
    }
  }

  async function handleImportFromSitemap(e?: React.FormEvent) {
    e?.preventDefault()
    await startImportWithWorker(importUrl)
  }

  const activeIsExpired = activeSource && Date.now() > (activeSource.expiresAt || 0)
  const pct =
    progress && progress.totalSitemaps > 0
      ? Math.min(100, Math.round((progress.processedSitemaps / progress.totalSitemaps) * 100))
      : progress
      ? 0
      : undefined

  useEffect(() => {
    setOmnibarInput(selected?.canonicalUrl || "")
  }, [selectedPageId])

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      {/* Left sidebar */}
      <aside className="hidden md:flex w-80 shrink-0 border-r flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-2">
            <BadgeCheck className="h-5 w-5 text-violet-600" />
            <div className="font-semibold">SiteBuilder</div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Menu className="h-4 w-4" />
          </Button>
        </div>
        <Separator />
        <Tabs defaultValue="pages" className="flex-1 flex flex-col">
          <TabsList className="m-3 grid grid-cols-3">
            <TabsTrigger value="pages">Pages</TabsTrigger>
            <TabsTrigger value="elements">Elements</TabsTrigger>
            <TabsTrigger value="design">Design</TabsTrigger>
          </TabsList>

          <TabsContent value="pages" className="flex-1 px-3">
            {/* Sidebar search using IDB */}
            <div className="flex items-center gap-3 px-1">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={sidebarQuery}
                  onChange={(e) => setSidebarQuery(e.target.value)}
                  className="pl-8"
                  placeholder="Search cached URLs (/products, /blog... or try 'product')"
                />
              </div>
              <Button size="icon" onClick={addPage}>
                <Plus className="h-4 w-4" />
                <span className="sr-only">Add page</span>
              </Button>
            </div>

            {/* Import + Refresh with progress */}
            <form onSubmit={handleImportFromSitemap} className="mt-4 rounded-lg border p-4 space-y-3">
              <div className="flex items-center gap-2">
                <LinkIcon className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="sitemap-url" className="text-xs text-muted-foreground">
                  Import pages from sitemap or index
                </Label>
              </div>
              <div className="flex flex-col gap-3">
                <Input
                  id="sitemap-url"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://example.com/sitemap.xml"
                  className="w-full"
                  disabled={isImporting && !!progress}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button type="submit" disabled={isImporting} className="w-full">
                    {isImporting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Import
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" /> Import
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => refreshSimple(importUrl)}
                    disabled={isImporting}
                    className="w-full"
                  >
                    <RefreshCcw className="mr-2 h-4 w-4" />
                    Refresh cache
                  </Button>
                </div>

                {progress && (
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between text-xs">
                      <span>
                        Sitemaps {progress.processedSitemaps.toLocaleString()}/
                        {progress.totalSitemaps.toLocaleString()}
                      </span>
                      <span>URLs imported {progress.urlsImported.toLocaleString()}</span>
                    </div>
                    <Progress value={pct} />
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        {pct !== undefined ? `${pct}%` : "Starting…"}
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={cancelImport}>
                        <Square className="mr-2 h-3.5 w-3.5" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {activeSource && activeSource.url === importUrl && (
                  <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
                    <span>
                      Cached: <span className="font-medium">{activeSource.total.toLocaleString()}</span> URLs
                    </span>
                    <span>Last sync: {new Date(activeSource.lastFetched).toLocaleString()}</span>
                    <span
                      className={cn(
                        "rounded px-1 py-0.5",
                        activeIsExpired ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                      )}
                    >
                      {activeIsExpired ? "Expired" : "Fresh"}
                    </span>
                  </div>
                )}
              </div>
            </form>

            {/* Results or normal list */}
            <ScrollArea className="mt-4 h-[calc(100dvh-460px)]">
              {sidebarResults ? (
                <div className="space-y-2">
                  <div className="px-1 text-xs text-muted-foreground">
                    Top {Math.min(10, sidebarResults.length)} results
                  </div>
                  <ul className="space-y-1">
                    {sidebarResults.map((r) => (
                      <li key={r.loc}>
                        <button
                          onClick={() => ensurePageFromRecord(r)}
                          className="w-full rounded-md px-2 py-2 text-left hover:bg-accent"
                          title={r.loc}
                        >
                          <span className="text-xs text-muted-foreground">{r.path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ul className="space-y-1">
                  {pages.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => setSelectedPageId(p.id)}
                        className={cn(
                          "w-full flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
                          p.id === selectedPageId && "bg-accent"
                        )}
                        aria-current={p.id === selectedPageId ? "page" : undefined}
                      >
                        <span
                          className={cn(
                            "inline-flex h-2 w-2 rounded-full",
                            p.online ? "bg-emerald-500" : "bg-muted-foreground"
                          )}
                          aria-hidden="true"
                        />
                        <span className="flex-1 truncate">{p.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>

            {/* Known sources list */}
            {sources.length > 0 && (
              <div className="mt-3 rounded-md border p-2">
                <div className="text-xs font-medium mb-1">Known sitemaps</div>
                <div className="space-y-1">
                  {sources
                    .sort((a, b) => b.lastFetched - a.lastFetched)
                    .map((s) => (
                      <button
                        key={s.url}
                        className="w-full text-left text-xs hover:underline"
                        onClick={() => setImportUrl(s.url)}
                        title={`${s.total.toLocaleString()} URLs`}
                      >
                        {s.url}
                      </button>
                    ))}
                </div>
              </div>
            )}

            <div className="mt-3 space-y-1 px-1">
              <Separator />
              <div className="grid grid-cols-3 gap-1 py-1">
                <Button variant="ghost" className="justify-start" size="sm">
                  <FileText className="mr-2 h-4 w-4" />
                  Files
                </Button>
                <Button variant="ghost" className="justify-start" size="sm">
                  <Settings className="mr-2 h-4 w-4" />
                </Button>
                <Button variant="ghost" className="justify-start" size="sm">
                  <HelpCircle className="mr-2 h-4 w-4" />
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="elements" className="px-3">
            <p className="text-sm text-muted-foreground">
              Drag components like Text, Image, Button, and Grid from here (demo).
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-md border p-3 text-sm flex items-center gap-2">
                <Type className="h-4 w-4" /> Heading
              </div>
              <div className="rounded-md border p-3 text-sm flex items-center gap-2">
                <ImageIcon className="h-4 w-4" /> Image
              </div>
            </div>
          </TabsContent>

          <TabsContent value="design" className="px-3">
            <p className="text-sm text-muted-foreground">Adjust theme colors and typography (demo).</p>
            <div className="mt-3 rounded-md border p-3 text-sm">Primary color: Violet</div>
          </TabsContent>
        </Tabs>
      </aside>

      {/* Main column */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Top bar with omnibar quicksearch */}
        <div className="relative flex items-center gap-2 border-b p-2">
          <Button variant="ghost" size="icon" className="hidden md:inline-flex h-8 w-8">
            <MousePointer className="h-4 w-4" />
            <span className="sr-only">Select</span>
          </Button>
          <div className="relative flex items-center gap-2 min-w-0 flex-1">
            <Badge variant="secondary" className="hidden sm:inline-flex">
              en
            </Badge>
            <div className="relative flex-1 min-w-0">
              <Input
                className="pl-8"
                value={omnibarInput}
                onChange={(e) => {
                  const v = e.target.value
                  setOmnibarInput(v)
                  // If it's a full URL, keep canonicalUrl in sync as you type.
                  if (v.includes("://")) {
                    updateSelected("canonicalUrl", v)
                  }
                }}
                aria-label="Omnibar"
                onFocus={() => {
                  const v = omnibarInput.trim()
                  if (v && (v.startsWith("/") || !v.includes("://"))) setShowOmniResults(true)
                }}
                onBlur={() => {
                  setTimeout(() => setShowOmniResults(false), 150)
                }}
                placeholder="Paste a full URL or type /path (or 'products') to quicksearch"
              />
              <Monitor className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />

              {showOmniResults && omniResults.length > 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
                  <ul className="max-h-72 overflow-auto py-1">
                    {omniResults.map((r) => (
                      <li key={r.loc}>
                        <button
                          className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            ensurePageFromRecord(r)
                            setOmnibarInput(r.loc)
                            updateSelected("canonicalUrl", r.loc)
                            setOmniResults([])
                            setShowOmniResults(false)
                          }}
                          title={r.loc}
                        >
                          {r.path}
                          <span className="ml-2 text-xs text-muted-foreground">{r.loc}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <Select value={device} onValueChange={(v: Device) => setDevice(v)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="Device" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desktop">
                  <div className="flex items-center gap-2">
                    <Laptop className="h-4 w-4" /> Desktop
                  </div>
                </SelectItem>
                <SelectItem value="tablet">
                  <div className="flex items-center gap-2">
                    <Tablet className="h-4 w-4" /> Tablet
                  </div>
                </SelectItem>
                <SelectItem value="mobile">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" /> Mobile
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary">Preview</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700">Publish</Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowReference((s) => !s)}>
              <ImageIcon className="h-4 w-4" />
              <span className="sr-only">Toggle reference</span>
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ChevronDown className="h-4 w-4" />
              <span className="sr-only">More</span>
            </Button>
          </div>
        </div>

        {/* Canvas */}
        <div className="relative flex-1 overflow-auto">
          <div className="mx-auto my-6 px-4">
            <Canvas device={device}>
              <Hero
                title={selected?.title || ""}
                description={selected?.description || ""}
                online={selected?.online || false}
              />
            </Canvas>
          </div>

          {/* Vertical tool rail */}
          <div className="pointer-events-none absolute left-2 top-16 hidden xl:block">
            <div className="pointer-events-auto flex flex-col gap-2 rounded-lg border bg-background p-2 shadow-sm">
              <Button variant="ghost" size="icon" className="h-9 w-9" title="Select">
                <MousePointer className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" title="Text">
                <Type className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" title="Image">
                <ImageIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </main>

      {/* Right sidebar */}
      <aside className="w-full max-w-sm shrink-0 border-l hidden lg:flex">
        <ScrollArea className="h-dvh w-full">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Metadata</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Online</span>
                <Switch
                  checked={selected?.online || false}
                  onCheckedChange={(v) => updateSelected("online", v)}
                  aria-label="Online"
                />
              </div>
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label htmlFor="path">Path</Label>
                <Input
                  id="path"
                  value={selected?.path || ""}
                  onChange={(e) => updateSelected("path", e.target.value)}
                  placeholder="/"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={selected?.title || ""}
                  onChange={(e) => updateSelected("title", e.target.value)}
                  placeholder="Page title"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="desc">Description</Label>
                <Textarea
                  id="desc"
                  value={selected?.description || ""}
                  onChange={(e) => updateSelected("description", e.target.value)}
                  placeholder="Describe this page..."
                  rows={5}
                />
              </div>
              <div className="grid gap-2">
                <Label>Social Image</Label>
                <div className="flex items-center gap-3">
                  <div className="h-16 w-16 rounded-md border bg-muted" aria-hidden="true" />
                  <Button variant="outline" size="sm">Choose</Button>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="exclude"
                  checked={selected?.exclude || false}
                  onCheckedChange={(v) => updateSelected("exclude", Boolean(v))}
                />
                <Label htmlFor="exclude">Exclude from search engines</Label>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="canonical">Canonical URL</Label>
                <Input
                  id="canonical"
                  value={selected?.canonicalUrl || ""}
                  onChange={(e) => updateSelected("canonicalUrl", e.target.value)}
                  placeholder="https://example.com/path"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="priority">Sitemap priority</Label>
                <div className="flex items-center gap-3">
                  <input
                    id="priority"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={selected?.priority ?? 0.5}
                    onChange={(e) => updateSelected("priority", Number(e.target.value))}
                    className="w-full"
                  />
                  <Badge variant="secondary">{(selected?.priority ?? 0.5).toFixed(2)}</Badge>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </aside>
    </div>
  )
}

function Canvas({
  children,
  device = "desktop",
}: {
  children: React.ReactNode
  device?: Device
}) {
  const size = device === "mobile" ? 380 : device === "tablet" ? 820 : 1200
  return (
    <div className="rounded-xl border bg-background shadow-sm" style={{ width: "100%" }}>
      <div className="mx-auto p-3" style={{ maxWidth: size }}>
        <div className="rounded-lg ring-1 ring-border overflow-hidden">{children}</div>
      </div>
    </div>
  )
}

function Hero({
  title = "Discover what's new",
  description = "Shop our latest arrivals and find something fresh and exciting for your home.",
  online = true,
}: {
  title?: string
  description?: string
  online?: boolean
}) {
  return (
    <div className="relative">
      <div className="absolute left-2 top-2 z-10">
        <span className="rounded-md bg-violet-600 px-2 py-1 text-xs font-medium text-white">
          Slideshow
        </span>
      </div>
      <div className="relative h-[380px] md:h-[460px]">
        <Image
          src="/placeholder.svg?height=920&width=1840"
          alt="Hero background featuring a houseplant"
          fill
          sizes="(max-width: 768px) 100vw, 100vw"
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-black/10" />
        <div className="absolute inset-0 flex items-end">
          <div className="p-6 md:p-10 text-white space-y-4">
            {!online && (
              <span className="rounded bg-amber-500/90 px-2 py-1 text-xs font-medium">Draft</span>
            )}
            <h1 className="text-3xl font-bold leading-tight md:text-5xl">{title}</h1>
            <p className="max-w-2xl text-white/90 md:text-lg">{description}</p>
            <Button size="lg" className="bg-emerald-600 hover:bg-emerald-700 text-white">
              Shop all
            </Button>
            <div className="mt-8 flex items-center gap-2 opacity-80">
              <Dot className="h-8 w-8 fill-white text-white" />
              <Dot className="h-8 w-8 text-white" />
              <Dot className="h-8 w-8 text-white" />
            </div>
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 ring-2 ring-violet-500/70" aria-hidden="true" />
    </div>
  )
}
