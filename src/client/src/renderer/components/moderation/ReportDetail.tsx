import React, { useState } from 'react'
import { useModerationStore } from '../../stores/moderationStore'
import { useServerStore } from '../../stores/serverStore'
import { cryptoService } from '../../services/crypto'
import { UnverifiedReportBanner } from './UnverifiedReportBanner'
import { MetadataCorroboration } from './MetadataCorroboration'
import { ActionConfirmDialog } from './ActionConfirmDialog'

interface ReportDetailProps {
  reportId: string
  serverId: string
  onBack: () => void
}

type ConfirmAction = {
  title: string
  message: string
  confirmLabel: string
  action: () => Promise<void>
}

const BAN_DURATIONS = [
  { label: 'Permanent', value: null },
  { label: '1 Hour', value: 3600000 },
  { label: '24 Hours', value: 86400000 },
  { label: '7 Days', value: 604800000 },
  { label: '30 Days', value: 2592000000 },
]

export function ReportDetail({ reportId, serverId, onBack }: ReportDetailProps): React.ReactElement {
  const report = useModerationStore((s) => s.reports.get(reportId))
  const reviewReport = useModerationStore((s) => s.reviewReport)
  const banUser = useModerationStore((s) => s.banUser)
  const kickUser = useModerationStore((s) => s.kickUser)
  const muteInChannel = useModerationStore((s) => s.muteInChannel)
  const channels = useServerStore((s) => s.channels)

  const [decryptedEvidence, setDecryptedEvidence] = useState<string | null>(null)
  const [decryptError, setDecryptError] = useState<string | null>(null)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [banDuration, setBanDuration] = useState<number | null>(null)

  if (!report) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-text-muted">Report not found</p>
      </div>
    )
  }

  // Determine if the channel is encrypted (private or DM)
  const channel = report.channel_id ? channels.get(report.channel_id) : null
  const isEncrypted = !channel || channel.encryption_mode === 'private'

  const handleDecrypt = async () => {
    if (!report.evidence_blob) return
    setIsDecrypting(true)
    setDecryptError(null)
    try {
      const result = await cryptoService.decryptReportEvidence(report.evidence_blob, serverId)
      setDecryptedEvidence(result.evidence)
    } catch (err) {
      setDecryptError(
        err instanceof Error ? err.message : 'Could not decrypt evidence. The moderation key may be incorrect or missing.'
      )
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleAction = async (action: string) => {
    await reviewReport(reportId, action)
    onBack()
  }

  const requestDismiss = () => {
    setConfirmAction({
      title: 'Dismiss Report',
      message: 'This will mark the report as dismissed. No action will be taken against the reported user.',
      confirmLabel: 'Dismiss',
      action: () => handleAction('dismissed'),
    })
  }

  const requestWarn = () => {
    setConfirmAction({
      title: 'Warn User',
      message: `A warning will be logged in the audit log for user ${report.reported_user_id.slice(0, 8)}. No enforcement action will be taken.`,
      confirmLabel: 'Warn',
      action: () => handleAction('warned'),
    })
  }

  const requestMute = () => {
    if (!report.channel_id) return
    setConfirmAction({
      title: 'Mute in Channel',
      message: `User ${report.reported_user_id.slice(0, 8)} will be muted in the channel for 1 hour.`,
      confirmLabel: 'Mute',
      action: async () => {
        await muteInChannel(report.channel_id!, report.reported_user_id, 3600)
        await handleAction('muted')
      },
    })
  }

  const requestKick = () => {
    setConfirmAction({
      title: 'Kick from Server',
      message: `User ${report.reported_user_id.slice(0, 8)} will be immediately removed from the server. They can rejoin using an invite.`,
      confirmLabel: 'Kick',
      action: async () => {
        await kickUser(serverId, report.reported_user_id, `Report: ${report.category}`)
        await handleAction('kicked')
      },
    })
  }

  const requestBan = () => {
    const durationLabel = banDuration === null
      ? 'permanently'
      : BAN_DURATIONS.find((d) => d.value === banDuration)?.label.toLowerCase() || 'temporarily'

    setConfirmAction({
      title: 'Ban from Server',
      message: `User ${report.reported_user_id.slice(0, 8)} will be banned ${durationLabel}. They will be disconnected and cannot rejoin.`,
      confirmLabel: 'Ban',
      action: async () => {
        const expiresAt = banDuration ? new Date(Date.now() + banDuration) : undefined
        await banUser(serverId, report.reported_user_id, `Report: ${report.category}`, expiresAt)
        await handleAction('banned')
      },
    })
  }

  let parsedEvidence: Record<string, unknown> | null = null
  if (decryptedEvidence) {
    try {
      parsedEvidence = JSON.parse(decryptedEvidence) as Record<string, unknown>
    } catch {
      parsedEvidence = null
    }
  }

  const isActioned = report.status !== 'pending'

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4">
      {/* Back button */}
      <button
        onClick={onBack}
        className="mb-4 flex items-center gap-1 text-sm text-text-muted hover:text-text-primary"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
        </svg>
        Back to Reports
      </button>

      {/* Report Metadata */}
      <div className="mb-4 rounded-lg bg-bg-tertiary p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Report Details</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-xs text-text-muted">Reporter</span>
            <p className="text-text-primary">{report.reporter_id.slice(0, 8)}</p>
          </div>
          <div>
            <span className="text-xs text-text-muted">Reported User</span>
            <p className="text-text-primary">{report.reported_user_id.slice(0, 8)}</p>
          </div>
          <div>
            <span className="text-xs text-text-muted">Category</span>
            <p className="text-text-primary capitalize">{report.category}</p>
          </div>
          <div>
            <span className="text-xs text-text-muted">Status</span>
            <p className="text-text-primary capitalize">{report.status}{report.action_taken ? ` (${report.action_taken})` : ''}</p>
          </div>
          <div className="col-span-2">
            <span className="text-xs text-text-muted">Description</span>
            <p className="text-text-primary">{report.description}</p>
          </div>
          <div>
            <span className="text-xs text-text-muted">Submitted</span>
            <p className="text-text-primary">{new Date(report.created_at).toLocaleString()}</p>
          </div>
          {report.channel_id && (
            <div>
              <span className="text-xs text-text-muted">Channel</span>
              <p className="text-text-primary">{channel?.name || 'Unknown / DM'}</p>
            </div>
          )}
        </div>
      </div>

      {/* Verification Banner */}
      <div className="mb-4">
        <UnverifiedReportBanner isEncrypted={isEncrypted} />
      </div>

      {/* Evidence Section */}
      <div className="mb-4 rounded-lg bg-bg-tertiary p-4">
        <h3 className="mb-3 text-sm font-semibold text-text-primary">Evidence</h3>
        {!report.evidence_blob ? (
          <p className="text-sm text-text-muted">
            No message content included. Reporter provided only metadata.
          </p>
        ) : decryptedEvidence && parsedEvidence ? (
          <div className="space-y-2">
            <div className="rounded bg-bg-primary p-3">
              <p className="text-xs text-text-muted">Message Content</p>
              <p className="mt-1 text-sm text-text-primary">{String(parsedEvidence.message_text ?? '')}</p>
            </div>
            {'sender_id' in parsedEvidence && (
              <p className="text-xs text-text-muted">
                Sender: {String(parsedEvidence.sender_id)} | Channel: {String(parsedEvidence.channel_id ?? 'N/A')} | Time: {String(parsedEvidence.timestamp ?? 'N/A')}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="mb-2 text-sm text-text-muted">
              Evidence is encrypted. Decrypt to view message content.
            </p>
            <button
              onClick={handleDecrypt}
              disabled={isDecrypting}
              className="rounded bg-bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isDecrypting ? 'Decrypting...' : 'Decrypt Evidence'}
            </button>
            {decryptError && (
              <p className="mt-2 text-sm text-red-400">{decryptError}</p>
            )}
          </div>
        )}
      </div>

      {/* Metadata Corroboration */}
      <div className="mb-4">
        <MetadataCorroboration serverId={serverId} userId={report.reported_user_id} />
      </div>

      {/* Action Buttons */}
      {!isActioned && (
        <div className="rounded-lg bg-bg-tertiary p-4">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Actions</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={requestDismiss}
              className="rounded bg-gray-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Dismiss
            </button>
            <button
              onClick={requestWarn}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Warn
            </button>
            {report.channel_id && (
              <button
                onClick={requestMute}
                className="rounded bg-yellow-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Mute in Channel
              </button>
            )}
            <button
              onClick={requestKick}
              className="rounded bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Kick
            </button>
            <div className="flex items-center gap-1">
              <select
                value={banDuration === null ? 'permanent' : String(banDuration)}
                onChange={(e) => setBanDuration(e.target.value === 'permanent' ? null : Number(e.target.value))}
                className="rounded bg-bg-secondary px-2 py-1.5 text-sm text-text-primary outline-none"
              >
                {BAN_DURATIONS.map((d) => (
                  <option key={d.label} value={d.value === null ? 'permanent' : String(d.value)}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                onClick={requestBan}
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Ban
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmAction && (
        <ActionConfirmDialog
          title={confirmAction.title}
          message={confirmAction.message}
          confirmLabel={confirmAction.confirmLabel}
          onConfirm={confirmAction.action}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  )
}
