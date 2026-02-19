import type { User, Server, Channel, Message } from './models'

// Auth
export interface RegisterRequest {
  username: string
  email: string
  password: string
}

export interface LoginRequest {
  email: string
  password: string
}

export interface AuthResponse {
  user_id: string
  access_token: string
  refresh_token: string
}

export interface RefreshRequest {
  refresh_token: string
}

export interface RefreshResponse {
  access_token: string
  refresh_token: string
}

// Servers
export interface CreateServerRequest {
  name: string
}

export interface UpdateServerRequest {
  name?: string
  description?: string
  icon_url?: string
}

export interface JoinServerRequest {
  invite_code: string
}

export type ServerResponse = Server

// Channels
export interface CreateChannelRequest {
  name: string
  channel_type?: 'text' | 'voice' | 'video'
  encryption_mode: 'standard' | 'private'
}

export interface UpdateChannelRequest {
  name: string
}

export type ChannelResponse = Channel

// Messages
export interface MessageHistoryParams {
  before?: string
  after?: string
  limit?: number
}

export type MessageResponse = Message

// Users
export type UserResponse = User

// API error shape
export interface ApiError {
  error: string
  status: number
}
