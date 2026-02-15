import React from 'react'
import { createRoot } from 'react-dom/client'

function App(): React.ReactElement {
  return <h1>Mercury</h1>
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
