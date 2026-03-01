import React, { useState } from 'react'
import { cryptoService } from '../../services/crypto'
import { moderation as moderationApi } from '../../services/api'

interface ModerationKeySetupProps {
  serverId: string
  onComplete: () => void
}

type Step = 'choose' | 'generating' | 'backup' | 'import' | 'done'

function numberArrayToBase64(arr: number[]): string {
  const bytes = new Uint8Array(arr)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToNumberArray(b64: string): number[] {
  const binary = atob(b64)
  const arr = new Array<number>(binary.length)
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i)
  }
  return arr
}

export function ModerationKeySetup({ serverId, onComplete }: ModerationKeySetupProps): React.ReactElement {
  const [step, setStep] = useState<Step>('choose')
  const [error, setError] = useState<string | null>(null)
  const [privateKeyBackup, setPrivateKeyBackup] = useState<string>('')
  const [importKey, setImportKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleGenerate = async () => {
    setStep('generating')
    setError(null)
    try {
      const { publicKey, privateKey } = await cryptoService.generateModerationKeypair()

      // Upload public key to server
      await moderationApi.setModerationKey(serverId, numberArrayToBase64(publicKey))

      // Store private key in Worker KeyStore
      await cryptoService.storeModerationPrivateKey(serverId, privateKey)

      // Show backup
      setPrivateKeyBackup(numberArrayToBase64(privateKey))
      setStep('backup')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate keypair')
      setStep('choose')
    }
  }

  const handleImport = async () => {
    if (!importKey.trim()) return
    setLoading(true)
    setError(null)
    try {
      const privateKey = base64ToNumberArray(importKey.trim())

      // Store private key — the Worker derives the public key
      await cryptoService.storeModerationPrivateKey(serverId, privateKey)

      // Generate the public key to upload (Worker derives from private)
      const { publicKey } = await cryptoService.generateModerationKeypair()
      await moderationApi.setModerationKey(serverId, numberArrayToBase64(publicKey))

      setStep('done')
      setTimeout(onComplete, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import key')
    } finally {
      setLoading(false)
    }
  }

  const handleCopyKey = async () => {
    await navigator.clipboard.writeText(privateKeyBackup)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (step === 'done') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium text-text-primary">Setup Complete</p>
          <p className="mt-1 text-sm text-text-muted">You can now decrypt report evidence.</p>
        </div>
      </div>
    )
  }

  if (step === 'generating') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-muted">Generating moderation keypair...</p>
      </div>
    )
  }

  if (step === 'backup') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg">
          <h3 className="mb-2 text-lg font-bold text-text-primary">Keypair Generated</h3>
          <p className="mb-4 text-sm text-text-secondary">
            Your moderation keypair has been generated. The public key has been uploaded to the server
            and the private key is stored locally.
          </p>

          <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
            <p className="mb-2 text-sm font-semibold text-yellow-300">
              Back up your private key
            </p>
            <p className="mb-3 text-xs text-yellow-200/80">
              Save this key securely. If you lose it, you will not be able to decrypt report evidence
              on a new device. The server does not store this key.
            </p>
            <div className="mb-2 rounded bg-bg-primary p-2">
              <code className="break-all text-xs text-text-primary">{privateKeyBackup}</code>
            </div>
            <button
              onClick={handleCopyKey}
              className="rounded bg-bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              {copied ? 'Copied!' : 'Copy Key'}
            </button>
          </div>

          <button
            onClick={() => {
              setStep('done')
              setTimeout(onComplete, 500)
            }}
            className="rounded bg-bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            I&apos;ve saved my key
          </button>
        </div>
      </div>
    )
  }

  if (step === 'import') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg">
          <h3 className="mb-2 text-lg font-bold text-text-primary">Import Existing Key</h3>
          <p className="mb-4 text-sm text-text-secondary">
            Paste your base64-encoded moderation private key below.
          </p>

          <textarea
            value={importKey}
            onChange={(e) => setImportKey(e.target.value)}
            placeholder="Paste base64 private key..."
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:ring-2 focus:ring-bg-accent"
            rows={3}
            disabled={loading}
          />

          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={() => { setStep('choose'); setError(null) }}
              disabled={loading}
              className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              Back
            </button>
            <button
              onClick={handleImport}
              disabled={loading || !importKey.trim()}
              className="rounded bg-bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Importing...' : 'Import Key'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // step === 'choose'
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-lg text-center">
        <h3 className="mb-2 text-lg font-bold text-text-primary">Set Up Moderation Encryption</h3>
        <p className="mb-6 text-sm text-text-secondary">
          To decrypt report evidence, you need a moderation keypair. The private key is stored
          only on your device — the server only has the public key.
        </p>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <div className="flex justify-center gap-3">
          <button
            onClick={handleGenerate}
            className="rounded bg-bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Generate New Keypair
          </button>
          <button
            onClick={() => setStep('import')}
            className="rounded bg-bg-tertiary px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-hover"
          >
            Import Existing Key
          </button>
        </div>
      </div>
    </div>
  )
}
