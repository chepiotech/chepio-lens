// Core
import { useCallback, useEffect, useRef, useState } from 'react'
// Services
import { fetchActivities } from '../api/lensApi'
// Types
import type { ActivityEventView } from '../api/generated/ActivityEventView'
import type { ActivityView } from '../api/generated/ActivityView'
import type { LogFilters } from '../logs/logState'
// Utils
import { activityQuery, mergeActivities } from '../activities/activityState'

type View = { activities: ActivityView[]; before: string | null; loading: boolean; error: string | null }
type LoadMode = 'latest' | 'refresh' | 'older'
const EMPTY: View = { activities: [], before: null, loading: false, error: null }

/**
 * The actions view, like `useLogs`: the server filters, SSE `activity` only says something changed. Activities named
 * in `replaces` were merged into another one and leave at once; `revisions` counts updates per activity, so an
 * expanded activity reloads its steps while its spans arrive.
 */
export function useActivities(filters: LogFilters, enabled: boolean, session: number, loadPage = fetchActivities) {
  const [view, setView] = useState<View>(EMPTY)
  const [following, setFollowing] = useState(true)
  const [hasNew, setHasNew] = useState(false)
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  const followingRef = useRef(true)
  const viewRef = useRef(view)
  const removed = useRef(new Set<string>())
  const commands = useRef<{ load: (mode: LoadMode) => void; invalidate: () => void } | null>(null)
  const query = activityQuery(filters)

  useEffect(() => {
    let alive = true
    let busy = false
    let next: LoadMode | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const update = (value: View) => { viewRef.current = value; setView(value) }
    update(EMPTY)
    removed.current = new Set()
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
        const page = await loadPage(query, mode === 'older' ? previous.before ?? undefined : undefined, controller.signal)
        if (!alive) return
        if (mode === 'refresh' && !followingRef.current) { setHasNew(true); return }
        const activities = mergeActivities(mode === 'latest' ? [] : previous.activities, page.activities, removed.current,
          mode === 'older' ? 'oldest' : 'newest')
        const before = mode === 'refresh' && previous.activities.length > 0 ? previous.before : page.next_before
        update({ activities, before, loading: false, error: null })
      } catch (error) {
        if (alive) update({ ...viewRef.current, loading: false, error: error instanceof Error ? error.message : 'Could not load actions.' })
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

  const onEvent = useCallback((event: ActivityEventView) => {
    if (event.replaces.length > 0) {
      for (const id of event.replaces) removed.current.add(id)
      const current = viewRef.current
      const kept = current.activities.filter((activity) => !event.replaces.includes(activity.id))
      if (kept.length !== current.activities.length) { viewRef.current = { ...current, activities: kept }; setView(viewRef.current) }
    }
    // An activity that came back under its own id is no longer one that was merged away.
    removed.current.delete(event.activity.id)
    setRevisions((value) => ({ ...value, [event.activity.id]: (value[event.activity.id] ?? 0) + 1 }))
    commands.current?.invalidate()
  }, [])
  const pause = useCallback(() => { followingRef.current = false; setFollowing(false) }, [])
  const resume = useCallback(() => {
    followingRef.current = true
    setFollowing(true)
    setHasNew(false)
    commands.current?.load('latest')
  }, [])
  const loadOlder = useCallback(() => { pause(); commands.current?.load('older') }, [pause])
  const reload = useCallback(() => commands.current?.load('latest'), [])
  const resync = useCallback(() => {
    if (followingRef.current) commands.current?.load('latest')
    else setHasNew(true)
  }, [])
  return { ...view, following, hasNew, revisions, onEvent, pause, resume, loadOlder, reload, resync }
}
