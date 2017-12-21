'use strict'

const assert = require('assert')
const crypto = require('crypto')
const oer = require('oer-utils')
const BigNumber = require('bignumber.js')
const Long = require('long')
const constants = require('./constants')

function serializePskPacket ({
  sharedSecret,
  type,
  paymentId,
  sequence,
  paymentAmount,
  chunkAmount,
  applicationData = Buffer.alloc(0),
  includeJunkData = true
}) {
  assert(Number.isInteger(type) && type < 256, 'type must be a UInt8')
  assert(Buffer.isBuffer(paymentId) && paymentId.length === 16, 'paymentId must be a 16-byte buffer')
  assert(Number.isInteger(sequence) && sequence <= constants.MAX_UINT32, 'sequence must be a UInt32')
  assert(paymentAmount instanceof BigNumber && paymentAmount.lte(constants.MAX_UINT64), 'paymentAmount must be a UInt64')
  assert(chunkAmount instanceof BigNumber && chunkAmount.lte(constants.MAX_UINT64), 'chunkAmount must be a UInt64')
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

function deserializePskPacket (sharedSecret, ciphertext) {
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

function encrypt (secret, data) {
  const buffer = Buffer.from(data, 'base64')
  const iv = crypto.randomBytes(constants.IV_LENGTH)
  const pskEncryptionKey = hmac(secret, constants.PSK_ENCRYPTION_STRING)
  const cipher = crypto.createCipheriv(constants.ENCRYPTION_ALGORITHM, pskEncryptionKey, iv)

  const encryptedInitial = cipher.update(buffer)
  const encryptedFinal = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    iv,
    tag,
    encryptedInitial,
    encryptedFinal
  ])
}

function decrypt (secret, data) {
  const buffer = Buffer.from(data, 'base64')
  const pskEncryptionKey = hmac(secret, constants.PSK_ENCRYPTION_STRING)
  const nonce = buffer.slice(0, constants.IV_LENGTH)
  const tag = buffer.slice(constants.IV_LENGTH, constants.IV_LENGTH + constants.AUTH_TAG_LENGTH)
  const encrypted = buffer.slice(constants.IV_LENGTH + constants.AUTH_TAG_LENGTH)
  const decipher = crypto.createDecipheriv(constants.ENCRYPTION_ALGORITHM, pskEncryptionKey, nonce)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
  h.update(Buffer.from(message, 'utf8'))
  return h.digest()
}

// oer-utils returns [high, low], whereas Long expects low first
function highLowToBigNumber (highLow) {
  // TODO use a more efficient method to convert this
  const long = Long.fromBits(highLow[1], highLow[0], true)
  return new BigNumber(long.toString(10))
}

function bigNumberToHighLow (bignum) {
  const long = Long.fromString(bignum.toString(10), true)
  return [long.getHighBitsUnsigned(), long.getLowBitsUnsigned()]
}

exports.serializePskPacket = serializePskPacket
exports.deserializePskPacket = deserializePskPacket
