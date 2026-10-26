// Core
import { useEffect, useState } from 'react'
// Types
import type { DemoCommand, DemoState } from '../../taskhub/taskhubSimulation'
// Utils
import { isRunning } from '../../taskhub/taskhubSimulation'

type Props = { state: DemoState; onRun: (command: DemoCommand) => void }

function TaskHubApp({ state, onRun }: Props) {
  const [section, setSection] = useState('Tasks')
  const [title, setTitle] = useState('Ship the onboarding flow')
  const [comment, setComment] = useState('Ready for review.')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(0)
  const selected = state.tasks.find((task) => task.id === selectedId) ?? state.tasks.at(-1)!
  const running = isRunning(state)
  const newestId = state.tasks.at(-1)!.id
  useEffect(() => setSelectedId(newestId), [newestId])
  return <>
    <div className="taskhub-app__identity"><span>{state.signedIn ? 'Alex Morgan · demo identity' : 'Demo workspace'}</span>
      <button type="button" disabled={running || state.signedIn} onClick={() => onRun({ type: 'signin' })}>{state.signedIn ? 'Signed in' : 'Sign in'}</button>
    </div>
    <h3>Platform launch</h3>
    <div className="taskhub-app__sections" aria-label="Demo app sections">
      {['Tasks', 'Search', 'Updates'].map((name) => <button key={name} type="button" aria-pressed={section === name} onClick={() => setSection(name)}>
        {name}{name === 'Updates' && state.notifications.length > 0 ? ` (${state.notifications.length})` : ''}
      </button>)}
    </div>
    {section === 'Tasks' && <>
      <form onSubmit={(event) => { event.preventDefault(); onRun({ type: 'task', value: title }) }}>
        <label htmlFor="taskhub-title">Task title</label>
        <input id="taskhub-title" maxLength={120} required value={title} onChange={(event) => setTitle(event.target.value)} />
        <button className="taskhub__primary" disabled={running || !title.trim()} type="submit">Create task</button>
      </form>
      <div className="taskhub-app__list-heading"><h4>Tasks</h4><span>{state.tasks.length} / 50</span></div>
      <ul className="taskhub-app__tasks" aria-label="Demo tasks">
        {[...state.tasks].reverse().map((task) => <li key={task.id}>
          <button type="button" aria-pressed={selected.id === task.id} onClick={() => setSelectedId(task.id)}>
            <span>{task.title}</span><small>{task.indexed ? 'Indexed' : 'Index pending'} · {task.comments.length} comments · {task.files.length} files</small>
          </button>
        </li>)}
      </ul>
      <h4 className="taskhub-app__selected">{selected.title}</h4>
      <form onSubmit={(event) => { event.preventDefault(); onRun({ type: 'comment', taskId: selected.id, value: comment }) }}>
        <label htmlFor="taskhub-comment">Comment</label>
        <textarea id="taskhub-comment" maxLength={280} required rows={2} value={comment} onChange={(event) => setComment(event.target.value)} />
        <button type="submit" disabled={running || !comment.trim()}>Add comment</button>
      </form>
      {selected.comments.length > 0 && <ul className="taskhub-app__entries" aria-label="Task comments">{selected.comments.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      <button type="button" className="taskhub-app__attach" disabled={running} onClick={() => onRun({ type: 'file', taskId: selected.id })}>Attach sample file</button>
      <p className="taskhub__muted">Uses a synthetic PDF. No local file is read or uploaded.</p>
      {selected.files.length > 0 && <ul className="taskhub-app__entries" aria-label="Task attachments">{selected.files.map((name) => <li key={name}>{name} · ready</li>)}</ul>}
    </>}
    {section === 'Search' && <>
      <form onSubmit={(event) => { event.preventDefault(); onRun({ type: 'search', value: query }) }}>
        <label htmlFor="taskhub-search">Search task titles</label>
        <input id="taskhub-search" type="search" maxLength={80} placeholder="Try “onboarding”" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="taskhub__primary" type="submit" disabled={running}>Search tasks</button>
      </form>
      <p className="taskhub__muted">Only indexed tasks appear. Search updates after the task has been saved.</p>
      {state.hasSearched ? <>
        <p>{state.searchResults.length} results{state.searchQuery ? ` for “${state.searchQuery}”` : ''}</p>
        <ul className="taskhub-app__entries" aria-label="Search results">{state.searchResults.map((id) => {
          const task = state.tasks.find((candidate) => candidate.id === id)
          return task ? <li key={id}>{task.title}</li> : null
        })}</ul>
        {state.searchResults.length === 0 && <p className="taskhub__muted">No matches. Try a shorter query or create a task.</p>}
      </> : <p className="taskhub-app__empty">Run a search to query the modeled OpenSearch index.</p>}
    </>}
    {section === 'Updates' && <>
      <p className="taskhub__muted">Persisted by the worker, then delivered over WebSocket.</p>
      {state.notifications.length ? <ul className="taskhub-app__entries" aria-label="Notifications">
        {[...state.notifications].reverse().map((item) => <li key={item.id}><strong>{item.text}</strong>
          <span>{state.tasks.find((task) => task.id === item.taskId)?.title ?? 'Earlier task'}</span>
          <small>{item.delivered ? 'Delivered over WebSocket' : 'Saved · push pending'}</small>
        </li>)}
      </ul> : <p className="taskhub-app__empty">Create a task or add a comment to trigger a notification.</p>}
    </>}
  </>
}

export default TaskHubApp
