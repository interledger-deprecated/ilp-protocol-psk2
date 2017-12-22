import crypto = require('crypto')
import * as constants from './constants'

export function dataToFulfillment (secret: Buffer, data: Buffer): Buffer {
  const key = hmac(secret, Buffer.from(constants.PSK_FULFILLMENT_STRING, 'utf8'))
  const fulfillment = hmac(key, data)
  return fulfillment
}

function hmac (key: Buffer, message: Buffer) {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

export function fulfillmentToCondition (preimage: Buffer): Buffer {
  const h = crypto.createHash('sha256')
  h.update(preimage)
  return h.digest()
}
