// Core
import { useEffect, useState } from 'react'
// Components
import StepList from './StepList'
// Services
import { fetchActivity } from '../../api/lensApi'
// Types
import type { ActivityDetailView } from '../../api/generated/ActivityDetailView'
import type { StepView } from '../../api/generated/StepView'

type Props = { id: string; revision: number; onInspect: (step: StepView) => void; loadActivity?: typeof fetchActivity }

/** Loads an expanded activity's steps, again on every update of the activity, keeping the last steps meanwhile. */
function ActivitySteps({ id, revision, onInspect, loadActivity = fetchActivity }: Props) {
  const [detail, setDetail] = useState<ActivityDetailView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    loadActivity(id, controller.signal)
      .then((value) => { setDetail(value); setError(null) })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load the steps.')
      })
    return () => controller.abort()
  }, [id, revision, loadActivity])
  if (error && !detail) return <p className="activity-list__note" role="alert">{error}</p>
  if (!detail) return <p className="activity-list__note">Loading steps…</p>
  return <StepList detail={detail} onInspect={onInspect} />
}

export default ActivitySteps
