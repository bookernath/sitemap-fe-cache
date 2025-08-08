import { Loader2 } from 'lucide-react'

export default function Loading() {
  return (
    <div className="flex h-dvh w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">Loading editor…</p>
      </div>
    </div>
  )
}
