// Crypto Worker Thread entry point
// Phase 5b: lifecycle only — spawn, message passing, graceful shutdown
// Crypto operations will be implemented in Phase 6
//
// Communication model:
//   Renderer ↔ Main (Electron MessagePort bridge) ↔ Worker (parentPort)
// Main bridges renderer messages to/from this worker via parentPort.
// safeStorage requests also go through parentPort to Main.

import { parentPort } from 'worker_threads'

if (!parentPort) {
  throw new Error('crypto-worker must be run as a Worker Thread')
}

let ready = false

parentPort.on('message', (msg: { op: string; id?: string; data?: unknown }) => {
  switch (msg.op) {
    case 'init:ready': {
      ready = true
      break
    }
    case 'ping': {
      // Echo pong — Main bridges this back to the renderer
      parentPort!.postMessage({ op: 'pong', data: msg.data ?? 'pong' })
      break
    }
    case 'safeStorage:result': {
      // Forward safeStorage results to the pending request
      // Phase 6 will use this for encrypted key storage
      break
    }
    case 'shutdown': {
      process.exit(0)
      break
    }
    // Phase 6: crypto operations (encrypt, decrypt, x3dh, etc.)
  }
})
