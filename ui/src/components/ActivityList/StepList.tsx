// Types
import type { ActivityDetailView } from '../../api/generated/ActivityDetailView'
import type { StepView } from '../../api/generated/StepView'
// Utils
import { formatOffset, STEP_DIRECTION, STEP_WORDS } from '../../activities/activityState'
import { formatMs } from '../../map/formatMs'

type Props = { detail: ActivityDetailView; onInspect: (step: StepView) => void }

const GLYPH = { out: '→', back: '←', here: '•' } as const

/** The chain of one activity in call-tree order (I13). Every value is rendered as text, never as markup (I11). */
function StepList({ detail, onInspect }: Props) {
  const crossesServices = detail.activity.services.length > 1
  return (
    <div className="activity-list__steps">
      {crossesServices && <p className="activity-list__note">Offsets are as each service's clock reports them; the order follows the calls.</p>}
      <ol aria-label={`Steps of ${detail.activity.title}`}>
        {detail.steps.map((step, index) => {
          const direction = STEP_DIRECTION[step.kind]
          return (
            <li key={`${step.span_id ?? 'record'}-${step.kind}-${index}`}
              className={`activity-list__step activity-list__step--${direction}${step.error ? ' activity-list__step--error' : ''}`}>
              <div className="activity-list__step-meta">
                <span className="activity-list__glyph" aria-hidden="true">{GLYPH[direction]}</span>
                <span className="activity-list__word">{STEP_WORDS[step.kind]}</span>
                <span className={`activity-list__tag activity-list__tag--${step.layer}`}>{step.layer}</span>
                <span className="activity-list__service">{step.service}</span>
                <span className="activity-list__offset">{formatOffset(step.offset_ms)}</span>
                {step.duration_ms !== null && <span>{formatMs(step.duration_ms)}</span>}
                {step.level && <span className="activity-list__status">{step.level}</span>}
              </div>
              <span className="activity-list__text">{step.text}</span>
              {step.details.map((detail) => (
                <details key={detail.label} className="activity-list__detail">
                  <summary>{detail.label}{detail.truncated ? ' · cut' : ''}</summary>
                  <pre>{detail.value}</pre>
                </details>
              ))}
              {step.trace_id && <button type="button" className="activity-list__inspect" onClick={() => onInspect(step)}>Open in inspector</button>}
            </li>
          )
        })}
      </ol>
      {detail.truncated_steps > 0 && <p className="activity-list__note">{detail.truncated_steps.toLocaleString()} more steps not shown.</p>}
    </div>
  )
}

export default StepList
