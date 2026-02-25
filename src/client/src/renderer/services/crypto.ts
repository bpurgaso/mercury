// Renderer-side crypto service — communicates with the Crypto Worker
// via the preload bridge (send/onMessage/onReady).
//
// The MessagePort stays in the preload context to avoid contextBridge
// transfer issues. The renderer only sends/receives plain data objects.
//
// The renderer never touches libsodium, private keys, or raw ciphertext bytes.
// It only posts requests and receives results.

type PendingOp = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

const pendingOps = new Map<string, PendingOp>()
let counter = 0
let portReadyResolve: (() => void) | null = null
const portReady = new Promise<void>((resolve) => {
  portReadyResolve = resolve
})

// Called from App init to wire up the crypto message bridge
export function initCryptoPort(): void {
  if (typeof window !== 'undefined' && window.mercury?.crypto) {
    // Register message handler — receives responses from crypto worker
    window.mercury.crypto.onMessage((data: unknown) => {
      const msg = data as { op: string; id: string; data?: unknown; error?: string }
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
    })

    // Resolve portReady when the crypto port is available in the preload
    window.mercury.crypto.onReady(() => {
      portReadyResolve?.()
    })
  }
}

async function postCryptoOp<T = unknown>(op: string, data?: Record<string, unknown>): Promise<T> {
  await portReady

  return new Promise<T>((resolve, reject) => {
    const id = `crypto-${++counter}`
    pendingOps.set(id, {
      resolve: (result) => resolve(result as T),
      reject,
    })
    window.mercury.crypto.send({ op, id, data })
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

export interface EncryptGroupResult {
  encrypted: {
    ciphertext: number[]
    nonce: number[]
    signature: number[]
    iteration: number
    epoch: number
    sender_device_id: string
  }
  distributions?: Array<{ device_id: string; ciphertext: number[] }>
  needsX3dh?: Array<{ userId: string; deviceId: string }>
  rawDistribution?: number[]
}

export interface DecryptGroupResult {
  plaintext?: string
  messageId?: string
  error?: 'MISSING_SENDER_KEY' | 'DECRYPT_FAILED'
}

export interface DistributeSenderKeyResult {
  distributions: Array<{ device_id: string; ciphertext: number[] }>
}

export interface GetPublicKeysResult {
  masterVerifyPublicKey: number[]
  deviceId: string
  deviceIdentityPublicKey: number[]
  signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
  unusedPreKeyCount: number
}

export interface GenerateAllKeysResult {
  masterVerifyPublicKey: number[]
  deviceId: string
  deviceIdentityPublicKey: number[]
  deviceIdentityEd25519PublicKey: number[]
  signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
  oneTimePreKeys: Array<{ keyId: number; publicKey: number[] }>
}

export interface CreateSignedDeviceListResult {
  signedList: number[]
  signature: number[]
  masterVerifyKey: number[]
}

export interface GenerateOtpResult {
  startId: number
  keys: Array<{ keyId: number; publicKey: number[] }>
}

export interface DistributeMediaKeyResult {
  distributed: boolean
  recipients: Array<{ user_id: string; device_id: string; ciphertext: number[] }>
}

export interface DecryptMediaKeyResult {
  key?: number[]
  epoch?: number
  roomId?: string
  error?: 'NO_SESSION' | 'DECRYPT_FAILED'
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

  encryptGroup(params: {
    channelId: string
    plaintext: string
    channelEpoch: number
    memberDevices: Array<{ userId: string; deviceId: string }>
  }): Promise<EncryptGroupResult> {
    return postCryptoOp<EncryptGroupResult>('crypto:encryptGroup', params)
  },

  decryptGroup(params: {
    channelId: string
    senderId: string
    senderDeviceId: string
    ciphertext: number[]
    nonce: number[]
    signature: number[]
    iteration: number
    epoch: number
    messageId: string
    createdAt: number
  }): Promise<DecryptGroupResult> {
    return postCryptoOp<DecryptGroupResult>('crypto:decryptGroup', params)
  },

  receiveSenderKeyDistribution(params: {
    channelId: string
    senderId: string
    senderDeviceId: string
    ciphertext: number[]
  }): Promise<{ stored: boolean; error?: string }> {
    return postCryptoOp('crypto:receiveSenderKeyDistribution', params)
  },

  distributeSenderKeyToDevices(params: {
    channelId: string
    devices: Array<{ userId: string; deviceId: string }>
  }): Promise<DistributeSenderKeyResult> {
    return postCryptoOp<DistributeSenderKeyResult>('crypto:distributeSenderKeyToDevices', params)
  },

  establishAndDistributeSenderKey(params: {
    channelId: string
    rawDistribution?: number[]
    devices: Array<{
      userId: string
      deviceId: string
      identityKey: number[]
      signedPreKey: { keyId: number; publicKey: number[]; signature: number[] }
      oneTimePreKey?: { keyId: number; publicKey: number[] }
    }>
  }): Promise<DistributeSenderKeyResult> {
    return postCryptoOp<DistributeSenderKeyResult>('crypto:establishAndDistributeSenderKey', params)
  },

  distributeMediaKey(params: {
    roomId: string
    recipientIds: string[]
    key: number[]
    epoch: number
  }): Promise<DistributeMediaKeyResult> {
    return postCryptoOp<DistributeMediaKeyResult>('crypto:distributeMediaKey', params)
  },

  decryptMediaKey(params: {
    senderId: string
    senderDeviceId: string
    ciphertext: number[]
  }): Promise<DecryptMediaKeyResult> {
    return postCryptoOp<DecryptMediaKeyResult>('crypto:decryptMediaKey', params)
  },

  markSenderKeyStale(channelId: string): Promise<{ marked: boolean }> {
    return postCryptoOp('crypto:markSenderKeyStale', { channelId })
  },

  getPublicKeys(): Promise<GetPublicKeysResult> {
    return postCryptoOp<GetPublicKeysResult>('crypto:getPublicKeys')
  },

  generateAllKeys(deviceId: string): Promise<GenerateAllKeysResult> {
    return postCryptoOp<GenerateAllKeysResult>('crypto:generateAllKeys', { deviceId })
  },

  createSignedDeviceList(deviceId: string, identityKeyB64: string): Promise<CreateSignedDeviceListResult> {
    return postCryptoOp<CreateSignedDeviceListResult>('crypto:createSignedDeviceList', { deviceId, identityKeyB64 })
  },

  generateOneTimePreKeys(count = 100): Promise<GenerateOtpResult> {
    return postCryptoOp<GenerateOtpResult>('crypto:generateOneTimePreKeys', { count })
  },
}
