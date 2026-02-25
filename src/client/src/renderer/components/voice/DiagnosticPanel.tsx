import React, { useEffect, useState, useRef } from 'react'
import { useCallStore } from '../../stores/callStore'
import { IceDiagnosticRunner, type DiagnosticResult, type CheckStatus } from '../../services/ice-diagnostics'
import { wsManager } from '../../services/websocket'

function StatusIcon({ status }: { status: CheckStatus }): React.ReactElement {
  if (status === 'pass') {
    return <span className="text-status-online">&#10003;</span>
  }
  if (status === 'fail') {
    return <span className="text-status-dnd">&#10007;</span>
  }
  return <span className="text-status-idle">~</span>
}

function statusLabel(status: CheckStatus): string {
  if (status === 'pass') return 'connected'
  if (status === 'fail') return 'failed'
  return 'checking...'
}

function getAdvice(result: DiagnosticResult): string {
  if (result.stun === 'fail' && result.turnUdp === 'fail' && result.turnTcp === 'fail') {
    return 'Your network appears to be heavily restricted. Try switching to a different network or contacting your network administrator.'
  }
  if (result.turnUdp === 'fail' && result.turnTcp === 'fail') {
    return 'Your network may be blocking relay traffic. Try switching to a different network or contacting your server administrator.'
  }
  if (result.turnUdp === 'fail') {
    return 'Your network may be blocking UDP traffic. TCP fallback is available but may result in higher latency.'
  }
  if (result.websocket === 'fail') {
    return 'WebSocket connection to the server was lost. Check your internet connection.'
  }
  return 'Some connectivity checks failed. Try switching to a different network.'
}

export function DiagnosticPanel(): React.ReactElement | null {
  const diagnosticState = useCallStore((s) => s.diagnosticState)
  const callConfig = useCallStore((s) => s.callConfig)
  const activeCall = useCallStore((s) => s.activeCall)

  const [result, setResult] = useState<DiagnosticResult | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const runnerRef = useRef<IceDiagnosticRunner | null>(null)

  const runDiagnostics = () => {
    if (!callConfig) return

    const runner = new IceDiagnosticRunner()
    runnerRef.current = runner

    runner.onProgress((r) => setResult(r))

    runner.run({
      wsConnected: wsManager.getState() === 'CONNECTED',
      stunUrls: callConfig.stunUrls,
      turnUrls: callConfig.turnUrls,
      turnUsername: callConfig.username,
      turnCredential: callConfig.credential,
      connectStartTime: activeCall?.joinedAt ?? null,
    }).then((finalResult) => {
      // Report to server
      if (activeCall) {
        wsManager.send('ice_diagnostic', {
          call_id: activeCall.roomId,
          stun: finalResult.stun === 'pass',
          turn_udp: finalResult.turnUdp === 'pass',
          turn_tcp: finalResult.turnTcp === 'pass',
          time_to_connected_ms: finalResult.timeToConnectedMs,
        })
      }
    })
  }

  useEffect(() => {
    if (diagnosticState?.failed && !dismissed) {
      runDiagnostics()
    }
    return () => {
      runnerRef.current?.abort()
    }
  }, [diagnosticState?.failed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!diagnosticState?.failed || dismissed) return null

  return (
    <div className="m-4 rounded-lg border border-border-subtle bg-bg-secondary p-4" data-testid="diagnostic-panel">
      <h3 className="mb-3 text-sm font-semibold text-text-primary">Connection Diagnostic</h3>

      {result && (
        <div className="mb-3 space-y-1 font-mono text-xs">
          <div className="flex items-center gap-2">
            <StatusIcon status={result.websocket} />
            <span className="text-text-secondary">WebSocket signaling</span>
            <span className="ml-auto text-text-muted">{statusLabel(result.websocket)}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusIcon status={result.stun} />
            <span className="text-text-secondary">STUN binding</span>
            <span className="ml-auto text-text-muted">{statusLabel(result.stun)}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusIcon status={result.turnUdp} />
            <span className="text-text-secondary">TURN relay (UDP)</span>
            <span className="ml-auto text-text-muted">{statusLabel(result.turnUdp)}</span>
          </div>
          <div className="flex items-center gap-2">
            <StatusIcon status={result.turnTcp} />
            <span className="text-text-secondary">TURN relay (TCP)</span>
            <span className="ml-auto text-text-muted">{statusLabel(result.turnTcp)}</span>
          </div>
        </div>
      )}

      {result && (result.stun === 'fail' || result.turnUdp === 'fail' || result.turnTcp === 'fail' || result.websocket === 'fail') && (
        <p className="mb-3 text-xs text-text-muted">{getAdvice(result)}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => {
            setResult(null)
            runDiagnostics()
          }}
          className="rounded bg-bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-bg-accent/80"
          data-testid="diagnostic-retry-btn"
        >
          Retry
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="rounded bg-bg-hover px-3 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-active"
          data-testid="diagnostic-dismiss-btn"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
