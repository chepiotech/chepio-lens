// Core
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
// Services
import { EVENT, EVENTS_URL, fetchGraph, resetCollector } from '../api/lensApi'
// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
import type { RequestView } from '../api/generated/RequestView'
// Utils
import { emptyGraph, graphReducer, mergeGraphSnapshot, type GraphAction, type GraphState } from '../map/graphState'

export type FeedStatus = 'connecting' | 'live' | 'offline'

/**
 * Live graph from the collector: subscribe to SSE first, then fetch the snapshot, so no event falls between the two.
 * `resync` and every reconnect fetch the snapshot again.
 */
export function useLensFeed(onRequest: (request: RequestView) => void) {
  const [graph, dispatch] = useReducer(graphReducer, emptyGraph)
  const [status, setStatus] = useState<FeedStatus>('connecting')
  const onRequestRef = useRef(onRequest)
  onRequestRef.current = onRequest
  const reloadRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const source = new EventSource(EVENTS_URL)
    let generation = 0
    let pending: { updates: GraphState } | null = null
    const load = async () => {
      const current = ++generation
      const buffer = { updates: emptyGraph }
      pending = buffer
      try {
        const snapshot = await fetchGraph()
        if (current !== generation) return
        dispatch({ type: 'snapshot', graph: mergeGraphSnapshot(snapshot, buffer.updates) })
      } catch {
        if (current === generation) setStatus('offline')
      } finally {
        if (current === generation) pending = null
      }
    }
    reloadRef.current = load
    const apply = (action: GraphAction) => {
      if (pending) pending.updates = graphReducer(pending.updates, action)
      dispatch(action)
    }
    source.onopen = () => {
      setStatus('live')
      void load()
    }
    // EventSource reconnects by itself; onopen then loads a fresh snapshot.
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
    source.addEventListener(EVENT.node, (event) =>
      apply({ type: 'node', node: JSON.parse(event.data) as NodeView }),
    )
    source.addEventListener(EVENT.edge, (event) =>
      apply({ type: 'edge', edge: JSON.parse(event.data) as EdgeView }),
    )
    source.addEventListener(EVENT.request, (event) => onRequestRef.current(JSON.parse(event.data) as RequestView))
    source.addEventListener(EVENT.resync, () => void load())
    return () => {
      generation += 1
      pending = null
      reloadRef.current = null
      source.close()
    }
  }, [])

  const reset = useCallback(async () => {
    await resetCollector()
    dispatch({ type: 'clear' })
    // Invalidate any earlier snapshot and recover calls that arrived immediately after the reset.
    await reloadRef.current?.()
  }, [])

  return { graph, status, reset }
}
