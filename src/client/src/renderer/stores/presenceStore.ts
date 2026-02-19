import { create } from 'zustand'
import type { PresenceStatus, UserPresence } from '../types/models'

interface PresenceState {
  presences: Map<string, UserPresence>

  updatePresence(userId: string, status: PresenceStatus): void
  setPresences(presences: UserPresence[]): void
  getPresence(userId: string): UserPresence | undefined
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  presences: new Map(),

  updatePresence(userId: string, status: PresenceStatus) {
    set((state) => {
      const presences = new Map(state.presences)
      presences.set(userId, { user_id: userId, status })
      return { presences }
    })
  },

  setPresences(presences: UserPresence[]) {
    set((state) => {
      const map = new Map(state.presences)
      for (const p of presences) {
        map.set(p.user_id, p)
      }
      return { presences: map }
    })
  },

  getPresence(userId: string) {
    return get().presences.get(userId)
  },
}))
