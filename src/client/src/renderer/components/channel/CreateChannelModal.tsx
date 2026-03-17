import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'

interface CreateChannelModalProps {
  serverId: string
  onClose: () => void
}

export function CreateChannelModal({ serverId, onClose }: CreateChannelModalProps): React.ReactElement {
  const [name, setName] = useState('')
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text')
  const [encryptionMode, setEncryptionMode] = useState<'standard' | 'private'>('standard')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const createChannel = useServerStore((s) => s.createChannel)
  const setActiveChannel = useServerStore((s) => s.setActiveChannel)
  const memberCount = useServerStore((s) => s.members.get(serverId)?.length ?? 0)
  const privateDisabled = memberCount > 100

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setIsLoading(true)
    setError('')
    try {
      const channel = await createChannel(serverId, name.trim(), channelType, encryptionMode)
      if (channelType === 'text') {
        setActiveChannel(channel.id)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-bg-secondary p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-xl font-bold text-text-primary">Create Channel</h2>

        {error && (
          <div className="mb-4 rounded bg-bg-danger/20 px-4 py-2 text-sm text-red-400">{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
            Channel Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            className="mb-4 w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
            placeholder={channelType === 'text' ? 'general' : 'voice-chat'}
            autoFocus
          />

          <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
            Channel Type
          </label>
          <div className="mb-4 space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded border border-border-subtle p-3 hover:bg-bg-hover">
              <input
                type="radio"
                name="channelType"
                value="text"
                checked={channelType === 'text'}
                onChange={() => setChannelType('text')}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-text-primary"># Text Channel</div>
                <div className="text-sm text-text-muted">Send messages, images, and files.</div>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded border border-border-subtle p-3 hover:bg-bg-hover">
              <input
                type="radio"
                name="channelType"
                value="voice"
                checked={channelType === 'voice'}
                onChange={() => setChannelType('voice')}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-text-primary">Voice Channel</div>
                <div className="text-sm text-text-muted">Voice and video chat with members.</div>
              </div>
            </label>
          </div>

          <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
            Encryption Mode
          </label>
          <div className="mb-4 space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded border border-border-subtle p-3 hover:bg-bg-hover">
              <input
                type="radio"
                name="encryption"
                value="standard"
                checked={encryptionMode === 'standard'}
                onChange={() => setEncryptionMode('standard')}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-text-primary">Community Channel</div>
                <div className="text-sm text-text-muted">Full message history, searchable. Best for public discussions.</div>
              </div>
            </label>
            <label className={`flex items-start gap-3 rounded border border-border-subtle p-3 ${privateDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-bg-hover'}`}>
              <input
                type="radio"
                name="encryption"
                value="private"
                checked={encryptionMode === 'private'}
                onChange={() => setEncryptionMode('private')}
                disabled={privateDisabled}
                className="mt-1"
              />
              <div>
                <div className="font-medium text-text-primary">Private Channel</div>
                <div className="text-sm text-text-muted">
                  End-to-end encrypted. Max 100 members. History only visible from join point.
                </div>
                {privateDisabled && (
                  <div className="mt-1 text-xs text-red-400">
                    This server has more than 100 members. Private channels are limited to 100 members.
                  </div>
                )}
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-4 py-2 text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="rounded bg-bg-accent px-4 py-2 font-medium text-white hover:bg-bg-accent-hover disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
