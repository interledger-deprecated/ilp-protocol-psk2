'use strict'

const crypto = require('crypto')
const constants = require('./constants')

function dataToFulfillment (secret, data) {
  const key = hmac(secret, constants.PSK_FULFILLMENT_STRING)
  const fulfillment = hmac(key, data)
  return fulfillment
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
  h.update(Buffer.from(message, 'utf8'))
  return h.digest()
}

function hash (preimage) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(preimage, 'base64'))
  return h.digest()
}

exports.dataToFulfillment = dataToFulfillment
exports.fulfillmentToCondition = hash
