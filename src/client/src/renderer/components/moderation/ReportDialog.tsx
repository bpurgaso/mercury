import React, { useState } from 'react'
import type { ReportCategory } from '../../types/models'
import { useModerationStore } from '../../stores/moderationStore'
import { moderation as moderationApi } from '../../services/api'
import { cryptoService } from '../../services/crypto'

interface ReportDialogProps {
  messageId: string
  senderId: string
  senderUsername: string
  channelId: string
  serverId?: string
  messageContent?: string | null
  onClose: () => void
}

const CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'illegal', label: 'Illegal Content' },
  { value: 'csam', label: 'CSAM' },
  { value: 'other', label: 'Other' },
]

function base64Encode(bytes: number[]): string {
  const uint8 = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i])
  }
  return btoa(binary)
}

function base64Decode(b64: string): number[] {
  const binary = atob(b64)
  const bytes = new Array<number>(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function ReportDialog({
  messageId,
  senderId,
  senderUsername,
  channelId,
  serverId,
  messageContent,
  onClose,
}: ReportDialogProps): React.ReactElement {
  const [category, setCategory] = useState<ReportCategory>('spam')
  const [description, setDescription] = useState('')
  const [includeEvidence, setIncludeEvidence] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const submitReport = useModerationStore((s) => s.submitReport)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!description.trim()) return

    setIsLoading(true)
    setError(null)

    try {
      let evidenceBlob: string | undefined

      if (includeEvidence && messageContent && serverId) {
        // Fetch operator's moderation public key
        const { public_key } = await moderationApi.getModerationKey(serverId)
        const moderationPubKey = base64Decode(public_key)

        // Encrypt evidence to operator's key
        const evidence = JSON.stringify({
          message_text: messageContent,
          sender_id: senderId,
          timestamp: new Date().toISOString(),
          channel_id: channelId,
        })

        const { encryptedEvidence } = await cryptoService.encryptReportEvidence(
          evidence,
          moderationPubKey,
        )
        evidenceBlob = base64Encode(encryptedEvidence)
      }

      await submitReport({
        reportedUserId: senderId,
        messageId,
        channelId,
        serverId,
        category,
        description: description.trim(),
        includeEvidence,
        evidenceBlob,
      })

      setSuccess(true)
      setTimeout(onClose, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit report')
    } finally {
      setIsLoading(false)
    }
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-[28rem] rounded-lg bg-bg-secondary p-6 text-center">
          <p className="text-lg font-medium text-text-primary">Report submitted</p>
          <p className="mt-1 text-sm text-text-secondary">
            Thank you for helping keep the community safe.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[28rem] rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-bold text-text-primary">Report Message</h2>
        <p className="mb-4 text-sm text-text-secondary">
          Report a message from {senderUsername}
        </p>

        <form onSubmit={handleSubmit}>
          {/* Category */}
          <label className="mb-2 block text-sm font-medium text-text-secondary">Category</label>
          <div className="mb-4 flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                onClick={() => setCategory(cat.value)}
                className={`rounded px-3 py-1.5 text-sm ${
                  category === cat.value
                    ? 'bg-bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Description */}
          <label className="mb-2 block text-sm font-medium text-text-secondary">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe why you're reporting this message..."
            className="mb-4 w-full rounded bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:ring-2 focus:ring-bg-accent"
            rows={3}
            disabled={isLoading}
          />

          {/* Evidence toggle */}
          {messageContent && serverId && (
            <div className="mb-4">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={includeEvidence}
                  onChange={(e) => setIncludeEvidence(e.target.checked)}
                  className="mt-0.5"
                  disabled={isLoading}
                />
                <div>
                  <span className="text-sm text-text-primary">Include message content in report</span>
                  {includeEvidence && (
                    <p className="mt-1 text-xs text-text-muted">
                      The message will be decrypted and re-encrypted so only the server operator can read it.
                    </p>
                  )}
                </div>
              </label>
            </div>
          )}

          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              disabled={isLoading || !description.trim()}
            >
              {isLoading ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
