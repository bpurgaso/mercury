import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { useDmChannelStore } from '../../stores/dmChannelStore'
import { ServerIcon } from '../server/ServerIcon'
import { CreateServerModal } from '../server/CreateServerModal'
import { JoinServerModal } from '../server/JoinServerModal'
import { NewDmModal } from '../dm/NewDmModal'

export function Sidebar(): React.ReactElement {
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const viewMode = useDmChannelStore((s) => s.viewMode)
  const setViewMode = useDmChannelStore((s) => s.setViewMode)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [showNewDmModal, setShowNewDmModal] = useState(false)

  const serverList = Array.from(servers.values())

  const handleServerClick = (serverId: string) => {
    setViewMode('server')
    setActiveServer(serverId)
  }

  const handleDmClick = () => {
    setViewMode('dm')
  }

  return (
    <>
      <div className="flex h-full w-[72px] flex-col items-center overflow-y-auto bg-bg-primary py-3">
        {/* DM button */}
        <div className="px-3 py-1">
          <button
            onClick={handleDmClick}
            title="Direct Messages"
            className={`flex h-12 w-12 items-center justify-center rounded-3xl transition-all hover:rounded-2xl ${
              viewMode === 'dm'
                ? 'rounded-2xl bg-bg-accent text-white'
                : 'bg-bg-tertiary text-text-secondary hover:bg-bg-accent hover:text-white'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M3.505 2.365A41.369 41.369 0 0 1 9 2c1.863 0 3.697.124 5.495.365 1.247.167 2.18 1.249 2.18 2.487v2.648a2.553 2.553 0 0 1-2.18 2.487 41.491 41.491 0 0 1-3.566.398l-3.143 2.357A.5.5 0 0 1 7 12.25V10.3a41.07 41.07 0 0 1-3.495-.365A2.553 2.553 0 0 1 1.325 7.5V4.852c0-1.238.933-2.32 2.18-2.487Z" />
            </svg>
          </button>
        </div>

        {/* Separator */}
        <div className="mx-auto my-1 h-0.5 w-8 rounded bg-border-subtle" />

        {/* Server icons */}
        {serverList.map((server) => (
          <ServerIcon
            key={server.id}
            server={server}
            isActive={viewMode === 'server' && activeServerId === server.id}
            onClick={() => handleServerClick(server.id)}
          />
        ))}

        {/* Separator */}
        <div className="mx-auto my-1 h-0.5 w-8 rounded bg-border-subtle" />

        {/* New DM button */}
        <div className="px-3 py-1">
          <button
            onClick={() => setShowNewDmModal(true)}
            title="New Direct Message"
            className="flex h-12 w-12 items-center justify-center rounded-3xl bg-bg-tertiary text-xl text-text-secondary transition-all hover:rounded-2xl hover:bg-bg-accent hover:text-white"
          >
            @
          </button>
        </div>

        {/* Add server button */}
        <div className="px-3 py-1">
          <button
            onClick={() => setShowCreateModal(true)}
            title="Create Server"
            className="flex h-12 w-12 items-center justify-center rounded-3xl bg-bg-tertiary text-xl text-status-online transition-all hover:rounded-2xl hover:bg-status-online hover:text-white"
          >
            +
          </button>
        </div>

        {/* Join server button */}
        <div className="px-3 py-1">
          <button
            onClick={() => setShowJoinModal(true)}
            title="Join Server"
            className="flex h-12 w-12 items-center justify-center rounded-3xl bg-bg-tertiary text-xl text-text-secondary transition-all hover:rounded-2xl hover:bg-bg-accent hover:text-white"
          >
            &#8594;
          </button>
        </div>
      </div>

      {showCreateModal && <CreateServerModal onClose={() => setShowCreateModal(false)} />}
      {showJoinModal && <JoinServerModal onClose={() => setShowJoinModal(false)} />}
      {showNewDmModal && <NewDmModal onClose={() => setShowNewDmModal(false)} />}
    </>
  )
}
