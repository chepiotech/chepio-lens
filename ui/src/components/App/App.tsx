// Components
import ChepioTechFooter from '../ChepioTechFooter/ChepioTechFooter'
// Styles
import './App.css'

function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">chepio-lens</h1>
      </header>
      <main className="app__main">
        <p className="app__empty">The live map appears here once the collector is running.</p>
      </main>
      <ChepioTechFooter />
    </div>
  )
}

export default App
