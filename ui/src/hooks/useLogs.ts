// Core
import { useCallback, useEffect, useRef, useState } from 'react'
// Services
import { fetchLogs } from '../api/lensApi'
// Types
import type { LogEntryView } from '../api/generated/LogEntryView'
import type { LogFilters } from '../logs/logState'
// Utils
import { LOG_VIEW_LIMIT, logQuery, mergeLogEntries } from '../logs/logState'

type View = { entries: LogEntryView[]; before: string | null; loading: boolean; error: string | null }
type LoadMode = 'latest' | 'refresh' | 'older'
const EMPTY: View = { entries: [], before: null, loading: false, error: null }

/** Server filtering remains authoritative, including edges linked after their first spans arrived. */
export function useLogs(filters: LogFilters, enabled: boolean, session: number, loadPage = fetchLogs) {
  const [view, setView] = useState<View>(EMPTY)
  const [following, setFollowing] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const followingRef = useRef(true)
  const viewRef = useRef(view)
  const commands = useRef<{ load: (mode: LoadMode) => void; invalidate: () => void } | null>(null)
  const query = logQuery(filters)

  useEffect(() => {
    let alive = true
    let busy = false
    let next: LoadMode | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const update = (value: View) => { viewRef.current = value; setView(value) }
    update(EMPTY)
    followingRef.current = true
    setFollowing(true)
    setHasNew(false)
    if (!enabled) return

    const load = async (mode: LoadMode) => {
      if (busy) { next = mode === 'latest' || next === 'latest' ? 'latest' : mode; return }
      const previous = viewRef.current
      if (mode === 'older' && !previous.before) return
      busy = true
      update({ ...previous, loading: mode !== 'refresh', error: null })
      try {
        let page = await loadPage(query, mode === 'older' ? previous.before ?? undefined : undefined, controller.signal)
        let incoming = page.entries
        // Catch a burst larger than one page, up to the view bound, without skipping its middle.
        const known = new Set(previous.entries.map((entry) => entry.id))
        while (mode === 'refresh' && known.size > 0 && page.next_before && incoming.length < LOG_VIEW_LIMIT
          && !incoming.some((entry) => known.has(entry.id))) {
          page = await loadPage(query, page.next_before, controller.signal)
          incoming = [...incoming, ...page.entries]
        }
        if (!alive) return
        if (mode === 'refresh' && !followingRef.current) { setHasNew(true); return }
        const entries = mergeLogEntries(mode === 'latest' ? [] : previous.entries, incoming, mode === 'older' ? 'oldest' : 'newest')
        const before = mode === 'refresh' && previous.entries.length > 0
          ? entries.length === LOG_VIEW_LIMIT ? entries[0]!.id : previous.before
          : page.next_before
        update({ entries, before, loading: false, error: null })
      } catch (error) {
        if (alive) update({ ...viewRef.current, loading: false, error: error instanceof Error ? error.message : 'Could not load logs.' })
      } finally {
        busy = false
        const pending = next
        next = null
        if (alive && pending && (pending !== 'refresh' || followingRef.current)) void load(pending)
      }
    }
    const invalidate = () => {
      if (!followingRef.current) { setHasNew(true); return }
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (followingRef.current) void load('refresh')
        else setHasNew(true)
      }, 250)
    }
    commands.current = { load: (mode) => { void load(mode) }, invalidate }
    void load('latest')
    return () => {
      alive = false
      controller.abort()
      clearTimeout(timer)
      commands.current = null
    }
  }, [query, enabled, session, loadPage])

  const pause = useCallback(() => { followingRef.current = false; setFollowing(false) }, [])
  const resume = useCallback(() => {
    followingRef.current = true
    setFollowing(true)
    setHasNew(false)
    commands.current?.load('latest')
  }, [])
  const loadOlder = useCallback(() => { pause(); commands.current?.load('older') }, [pause])
  const invalidate = useCallback(() => commands.current?.invalidate(), [])
  const reload = useCallback(() => commands.current?.load('latest'), [])
  const resync = useCallback(() => {
    if (followingRef.current) commands.current?.load('latest')
    else setHasNew(true)
  }, [])
  return { ...view, following, hasNew, pause, resume, loadOlder, invalidate, reload, resync }
}
