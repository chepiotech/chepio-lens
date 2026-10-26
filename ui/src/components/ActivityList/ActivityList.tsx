// Components
import ActivitySteps from './ActivitySteps'
// Types
import type { fetchActivity } from '../../api/lensApi'
import type { ActivityView } from '../../api/generated/ActivityView'
import type { StepView } from '../../api/generated/StepView'
// Styles
import './ActivityList.css'
// Utils
import { logTime } from '../../logs/logState'
import { formatMs } from '../../map/formatMs'

type Props = {
  activities: ActivityView[]
  revisions: Record<string, number>
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
  loadActivity?: typeof fetchActivity
  onInspect: (step: StepView) => void
}

/** One row per activity (ADR-0016); an expanded row shows its chain of steps. */
function ActivityList({ activities, revisions, expanded, onToggle, onInspect, loadActivity }: Props) {
  return (
    <ol className="activity-list" aria-label="Actions">
      {activities.map((activity) => {
        const open = expanded.has(activity.id)
        return (
          <li key={activity.id} data-activity-id={activity.id}>
            <button type="button" className={`activity-list__row${activity.error ? ' activity-list__row--error' : ''}`}
              aria-expanded={open} onClick={() => onToggle(activity.id)}>
              <span className="activity-list__meta">
                <time>{logTime(activity.time)}</time>
                {activity.layers.map((layer) => <span key={layer} className={`activity-list__tag activity-list__tag--${layer}`}>{layer}</span>)}
                <span className="activity-list__service">{activity.origin === 'action' ? 'user action' : activity.service}</span>
                <span className="activity-list__status">{activity.status_code ?? (activity.error ? 'error' : '')}</span>
                {activity.duration_ms !== null && <span>{formatMs(activity.duration_ms)}</span>}
                <span>{activity.lines === 1 ? '1 line' : `${activity.lines} lines`}</span>
              </span>
              <span className="activity-list__title">{activity.title}</span>
            </button>
            {open && <ActivitySteps loadActivity={loadActivity} id={activity.id} revision={revisions[activity.id] ?? 0} onInspect={onInspect} />}
          </li>
        )
      })}
    </ol>
  )
}

export default ActivityList
