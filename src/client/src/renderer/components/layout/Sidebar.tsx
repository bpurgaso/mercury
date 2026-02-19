import React, { useState } from 'react'
import { useServerStore } from '../../stores/serverStore'
import { ServerIcon } from '../server/ServerIcon'
import { CreateServerModal } from '../server/CreateServerModal'
import { JoinServerModal } from '../server/JoinServerModal'

export function Sidebar(): React.ReactElement {
  const servers = useServerStore((s) => s.servers)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showJoinModal, setShowJoinModal] = useState(false)

  const serverList = Array.from(servers.values())

  return (
    <>
      <div className="flex h-full w-[72px] flex-col items-center overflow-y-auto bg-bg-primary py-3">
        {/* Server icons */}
        {serverList.map((server) => (
          <ServerIcon
            key={server.id}
            server={server}
            isActive={activeServerId === server.id}
            onClick={() => setActiveServer(server.id)}
          />
        ))}

        {/* Separator */}
        <div className="mx-auto my-1 h-0.5 w-8 rounded bg-border-subtle" />

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
    </>
  )
}
