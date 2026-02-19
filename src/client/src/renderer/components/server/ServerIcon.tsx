import React from 'react'
import type { Server } from '../../types/models'

interface ServerIconProps {
  server: Server
  isActive: boolean
  onClick: () => void
}

export function ServerIcon({ server, isActive, onClick }: ServerIconProps): React.ReactElement {
  const initials = server.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="group relative flex items-center justify-center px-3 py-1">
      {/* Active indicator */}
      <div
        className={`absolute left-0 w-1 rounded-r-full bg-white transition-all ${
          isActive ? 'h-10' : 'h-0 group-hover:h-5'
        }`}
      />

      <button
        onClick={onClick}
        title={server.name}
        className={`flex h-12 w-12 items-center justify-center text-sm font-semibold transition-all ${
          isActive
            ? 'rounded-2xl bg-bg-accent text-white'
            : 'rounded-3xl bg-bg-tertiary text-text-primary hover:rounded-2xl hover:bg-bg-accent hover:text-white'
        }`}
      >
        {server.icon_url ? (
          <img
            src={server.icon_url}
            alt={server.name}
            className="h-full w-full rounded-[inherit] object-cover"
          />
        ) : (
          initials
        )}
      </button>
    </div>
  )
}
