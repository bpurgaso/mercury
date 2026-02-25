import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Expose dev flag so WebRTCManager can attach the PeerConnection to window for E2E tests
if (process.env.NODE_ENV === 'development') {
  (window as Record<string, unknown>).__MERCURY_DEV__ = true
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
