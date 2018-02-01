import BigNumber from 'bignumber.js'

// PSK Packet Types
export const TYPE_PSK2_CHUNK = 0
export const TYPE_PSK2_LAST_CHUNK = 1
export const TYPE_PSK2_FULFILLMENT = 2
export const TYPE_PSK2_REJECT = 3
export const TYPE_PSK2_REQUEST = 4
export const TYPE_PSK2_RESPONSE = 5
export const TYPE_PSK2_ERROR = 6

// PSK Parameters
export const PSK_FULFILLMENT_STRING = 'ilp_psk2_fulfillment'
export const PSK_ENCRYPTION_STRING = 'ilp_psk2_encryption'
export const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
export const IV_LENGTH = 12
export const AUTH_TAG_LENGTH = 16

// Integers
export const MAX_UINT8 = 255
export const MAX_UINT32 = 4294967295
export const MAX_UINT64 = new BigNumber('18446744073709551615')
