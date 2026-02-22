// Renderer-side crypto service — communicates with the Crypto Worker
// via the Electron MessagePort bridge.
//
// The renderer never touches libsodium, private keys, or raw ciphertext bytes.
// It only posts requests and receives results.

type PendingOp = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

let cryptoPort: MessagePort | null = null
const pendingOps = new Map<string, PendingOp>()
let counter = 0
let portReadyResolve: (() => void) | null = null
const portReady = new Promise<void>((resolve) => {
  portReadyResolve = resolve
})

// Called from App init when the crypto port is received from main process
export function initCryptoPort(): void {
  if (typeof window !== 'undefined' && window.mercury) {
    window.mercury.onCryptoPort((port: MessagePort) => {
      cryptoPort = port
      port.onmessage = (event: MessageEvent) => {
        const msg = event.data as { op: string; id: string; data?: unknown; error?: string }
        if (msg.op === 'crypto:result' || msg.op === 'crypto:error') {
          const pending = pendingOps.get(msg.id)
          if (!pending) return
          pendingOps.delete(msg.id)
          if (msg.op === 'crypto:error') {
            pending.reject(new Error(msg.error || 'Unknown crypto error'))
          } else {
            pending.resolve(msg.data)
          }
        }
      }
      portReadyResolve?.()
    })
  }
}

async function postCryptoOp<T = unknown>(op: string, data?: Record<string, unknown>): Promise<T> {
  await portReady
  if (!cryptoPort) throw new Error('Crypto port not available')

  return new Promise<T>((resolve, reject) => {
    const id = `crypto-${++counter}`
    pendingOps.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    })
    cryptoPort!.postMessage({ op, id, data })
  })
}

// --- Public API ---

export interface EncryptDmResult {
  recipients: Array<{
    device_id: string
    ciphertext: Uint8Array
    ratchet_header: Uint8Array
  }>
}

export interface EstablishAndEncryptDmResult {
  recipients?: Array<{
    device_id: string
    ciphertext: Uint8Array
    ratchet_header: Uint8Array
    x3dh_header: {
      sender_identity_key: Uint8Array
      ephemeral_key: Uint8Array
      prekey_id: number
    }
  }>
  error?: 'IDENTITY_CHANGED'
  previousKey?: number[]
  newKey?: number[]
}

export interface DecryptDmResult {
  plaintext?: string
  messageId?: string
  error?: 'NO_SESSION' | 'DECRYPT_FAILED'
}

export interface HasSessionsResult {
  userId: string
  deviceId: string
  hasSession: boolean
}

export interface VerifyDeviceListResult {
  verified: boolean
  firstSeen?: boolean
  error?: 'SIGNATURE_INVALID' | 'IDENTITY_CHANGED'
  previousKey?: number[]
  newKey?: number[]
  devices?: Array<{ device_id: string; identity_key: string }>
}

export interface StoredMessageResult {
  id: string
  channelId: string
  senderId: string
  content: string
  createdAt: number
  receivedAt: number
}

export const cryptoService = {
  verifyDeviceList(
    userId: string,
    signedList: number[],
    masterVerifyKey: number[],
    signature: number[],
  ): Promise<VerifyDeviceListResult> {
    return postCryptoOp<VerifyDeviceListResult>('crypto:verifyDeviceList', {
      userId,
      signedList,
      masterVerifyKey,
      signature,
    })
  },

  hasSessions(devices: Array<{ userId: string; deviceId: string }>): Promise<HasSessionsResult[]> {
    return postCryptoOp<HasSessionsResult[]>('crypto:hasSessions', { devices })
  },

  encryptDm(
    recipientId: string,
    devices: Array<{ deviceId: string }>,
    plaintext: string,
  ): Promise<EncryptDmResult> {
    return postCryptoOp<EncryptDmResult>('crypto:encryptDm', {
      recipientId,
      devices,
      plaintext,
    })
  },

  establishAndEncryptDm(
    recipientId: string,
    recipientMasterVerifyKey: number[],
    keyBundles: Array<{
      deviceId: string
      identityKey: number[]
      signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
      oneTimePreKey?: { keyId: number; publicKey: number[] }
    }>,
    plaintext: string,
  ): Promise<EstablishAndEncryptDmResult> {
    return postCryptoOp<EstablishAndEncryptDmResult>('crypto:establishAndEncryptDm', {
      recipientId,
      recipientMasterVerifyKey,
      keyBundles,
      plaintext,
    })
  },

  decryptDm(params: {
    messageId: string
    dmChannelId: string
    senderId: string
    senderDeviceId: string
    ciphertext: number[]
    x3dhHeader?: {
      senderIdentityKey: number[]
      ephemeralKey: number[]
      prekeyId: number
    }
    createdAt: number
  }): Promise<DecryptDmResult> {
    return postCryptoOp<DecryptDmResult>('crypto:decryptDm', params)
  },

  acceptIdentityChange(userId: string, newKey: number[]): Promise<{ accepted: boolean }> {
    return postCryptoOp('crypto:acceptIdentityChange', { userId, newKey })
  },

  storeMessage(message: {
    id: string
    channelId: string
    senderId: string
    content: string
    createdAt: number
  }): Promise<{ stored: boolean }> {
    return postCryptoOp('crypto:storeMessage', message)
  },

  getMessages(
    channelId: string,
    limit = 50,
    offset = 0,
  ): Promise<StoredMessageResult[]> {
    return postCryptoOp<StoredMessageResult[]>('crypto:getMessages', {
      channelId,
      limit,
      offset,
    })
  },
}
