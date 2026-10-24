// Core
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
// Services
import { EVENT, EVENTS_URL, fetchGraph, resetCollector } from '../api/lensApi'
// Types
import type { EdgeView } from '../api/generated/EdgeView'
import type { NodeView } from '../api/generated/NodeView'
import type { RequestView } from '../api/generated/RequestView'
// Utils
import { emptyGraph, graphReducer } from '../map/graphState'

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

  useEffect(() => {
    const source = new EventSource(EVENTS_URL)
    const load = () =>
      fetchGraph().then(
        (snapshot) => dispatch({ type: 'snapshot', graph: snapshot }),
        () => setStatus('offline'),
      )
    source.onopen = () => {
      setStatus('live')
      void load()
    }
    // EventSource reconnects by itself; onopen then loads a fresh snapshot.
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')
    source.addEventListener(EVENT.node, (event) =>
      dispatch({ type: 'node', node: JSON.parse(event.data) as NodeView }),
    )
    source.addEventListener(EVENT.edge, (event) =>
      dispatch({ type: 'edge', edge: JSON.parse(event.data) as EdgeView }),
    )
    source.addEventListener(EVENT.request, (event) => onRequestRef.current(JSON.parse(event.data) as RequestView))
    source.addEventListener(EVENT.resync, () => void load())
    return () => source.close()
  }, [])

  const reset = useCallback(async () => {
    await resetCollector()
    dispatch({ type: 'clear' })
  }, [])

  return { graph, status, reset }
}
