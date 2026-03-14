import React, { useState } from 'react'
import { useAuthStore } from '../stores/authStore'

interface RegisterPageProps {
  onSwitchToLogin: () => void
  onChangeServer: () => void
}

export function RegisterPage({ onSwitchToLogin, onChangeServer }: RegisterPageProps): React.ReactElement {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { register, isLoading, error, clearError } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    clearError()
    try {
      await register(username, email, password)
    } catch {
      // error is set in the store
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-primary">
      <div className="w-full max-w-md rounded-lg bg-bg-secondary p-8 shadow-lg">
        <h1 className="mb-2 text-center text-2xl font-bold text-text-primary">Create an account</h1>
        <p className="mb-6 text-center text-text-muted">Join Mercury today</p>

        {error && (
          <div className="mb-4 rounded bg-bg-danger/20 px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={2}
              maxLength={32}
              className="w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
              placeholder="cooluser"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-bold uppercase text-text-secondary">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded bg-bg-input px-3 py-2 text-text-primary outline-none focus:ring-2 focus:ring-bg-accent"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded bg-bg-accent py-2 font-medium text-white transition-colors hover:bg-bg-accent-hover disabled:opacity-50"
          >
            {isLoading ? 'Creating account...' : 'Register'}
          </button>
        </form>

        <p className="mt-4 text-sm text-text-muted">
          Already have an account?{' '}
          <button
            onClick={onSwitchToLogin}
            className="text-text-link hover:underline"
          >
            Log In
          </button>
        </p>

        <p className="mt-2 text-center text-sm">
          <button
            onClick={onChangeServer}
            className="text-text-muted hover:text-text-primary hover:underline"
          >
            Change server
          </button>
        </p>
      </div>
    </div>
  )
}
