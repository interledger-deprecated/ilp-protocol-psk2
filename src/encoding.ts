import * as assert from 'assert'
import * as crypto from 'crypto'
import * as oer from 'oer-utils'
import BigNumber from 'bignumber.js'
import * as Long from 'long'
import * as constants from './constants'

export interface PskPacket {
  type: number,
  paymentId: Buffer,
  sequence: number,
  paymentAmount: BigNumber,
  chunkAmount: BigNumber,
  applicationData?: Buffer
}

export function serializePskPacket (sharedSecret: Buffer, pskPacket: PskPacket): Buffer {
  const {
    type,
    paymentId,
    sequence,
    paymentAmount,
    chunkAmount,
    applicationData = Buffer.alloc(0)
  } = pskPacket
  assert(Number.isInteger(type) && type < 256, 'type must be a UInt8')
  assert(Buffer.isBuffer(paymentId) && paymentId.length === 16, 'paymentId must be a 16-byte buffer')
  assert(Number.isInteger(sequence) && sequence <= constants.MAX_UINT32, 'sequence must be a UInt32')
  assert(paymentAmount instanceof BigNumber && paymentAmount.isInteger() && paymentAmount.lte(constants.MAX_UINT64), 'paymentAmount must be a UInt64')
  assert(chunkAmount instanceof BigNumber && chunkAmount.isInteger() && chunkAmount.lte(constants.MAX_UINT64), 'chunkAmount must be a UInt64')
  assert(Buffer.isBuffer(applicationData), 'applicationData must be a buffer')

  const writer = new oer.Writer()
  writer.writeUInt8(type)
  writer.writeOctetString(paymentId, 16)
  writer.writeUInt32(sequence)
  writer.writeUInt64(bigNumberToHighLow(paymentAmount))
  writer.writeUInt64(bigNumberToHighLow(chunkAmount))
  writer.writeVarOctetString(applicationData)
  writer.writeUInt8(0) // OER extensibility
  const contents = writer.getBuffer()

  // TODO add junk data

  const ciphertext = encrypt(sharedSecret, contents)
  return ciphertext
}

export function deserializePskPacket (sharedSecret: Buffer, ciphertext: Buffer): PskPacket {
  const contents = decrypt(sharedSecret, ciphertext)
  const reader = new oer.Reader(contents)

  return {
    type: reader.readUInt8(),
    paymentId: reader.readOctetString(16),
    sequence: reader.readUInt32(),
    paymentAmount: highLowToBigNumber(reader.readUInt64()),
    chunkAmount: highLowToBigNumber(reader.readUInt64()),
    applicationData: reader.readVarOctetString()
  }
}

function encrypt (secret: Buffer, data: Buffer): Buffer {
  const iv = crypto.randomBytes(constants.IV_LENGTH)
  const pskEncryptionKey = hmac(secret, Buffer.from(constants.PSK_ENCRYPTION_STRING, 'utf8'))
  const cipher = crypto.createCipheriv(constants.ENCRYPTION_ALGORITHM, pskEncryptionKey, iv)

  const encryptedInitial = cipher.update(data)
  const encryptedFinal = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    iv,
    tag,
    encryptedInitial,
    encryptedFinal
  ])
}

function decrypt (secret: Buffer, data: Buffer): Buffer {
  assert(data.length > 0, 'cannot decrypt empty buffer')
  const pskEncryptionKey = hmac(secret, Buffer.from(constants.PSK_ENCRYPTION_STRING, 'utf8'))
  const nonce = data.slice(0, constants.IV_LENGTH)
  const tag = data.slice(constants.IV_LENGTH, constants.IV_LENGTH + constants.AUTH_TAG_LENGTH)
  const encrypted = data.slice(constants.IV_LENGTH + constants.AUTH_TAG_LENGTH)
  const decipher = crypto.createDecipheriv(constants.ENCRYPTION_ALGORITHM, pskEncryptionKey, nonce)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])
}

function hmac (key: Buffer, message: Buffer): Buffer {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

// oer-utils returns [high, low], whereas Long expects low first
function highLowToBigNumber (highLow: number[]): BigNumber {
  // TODO use a more efficient method to convert this
  const long = Long.fromBits(highLow[1], highLow[0], true)
  return new BigNumber(long.toString(10))
}

function bigNumberToHighLow (bignum: BigNumber): number[] {
  const long = Long.fromString(bignum.toString(10), true)
  return [long.getHighBitsUnsigned(), long.getLowBitsUnsigned()]
}
