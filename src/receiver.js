'use strict'

const assert = require('assert')
const debug = require('debug')('ilp-psk2:receiver')
const BigNumber = require('bignumber.js')
const convertToV2Plugin = require('ilp-compat-plugin')
const IlpPacket = require('ilp-packet')
const constants = require('./constants')
const { serializePskPacket, deserializePskPacket } = require('./encoding')
const { dataToFulfillment, fulfillmentToCondition } = require('./condition')

function listen (plugin, {
  secret,
  notifyEveryChunk,
  acceptableOverpaymentMultiple = 1.01
}) {
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')
  plugin = convertToV2Plugin(plugin)

  const payments = {}

  plugin.registerTransferHandler(handlePrepare)

  async function handlePrepare (transfer) {
    // TODO check that destination matches our address

    // TODO use a different shared secret for each sender
    const sharedSecret = secret

    let packet
    let request
    let err
    try {
      packet = IlpPacket.deserializeIlpForwardedPayment(transfer.ilp)
      request = deserializePskPacket(secret, packet.data)
    } catch (err) {
      debug('error decrypting data:', err)
      err = new Error('unable to decrypt data')
      err.name = 'InterledgerRejectionError'
      err.ilp = IlpPacket.serializeIlpRejection({
        code: 'F01',
        message: 'unable to decrypt data',
        data: Buffer.alloc(0),
        triggeredBy: ''
      })
      throw err
    }

    if (request.type !== constants.TYPE_CHUNK && request.type !== constants.TYPE_LAST_CHUNK) {
      debug(`got unexpected request type: ${request.type}`)
      err = new Error(`unexpected request type: ${request.type}`)
      err.name = 'InterledgerRejectionError'
      err.ilpRejection = IlpPacket.serializeIlpRejection({
        code: 'F06',
        message: 'wrong type',
        data: Buffer.alloc(0),
        triggeredBy: ''
      })
      throw err
    }

    const paymentId = request.paymentId.toString('hex')
    let record = payments[paymentId]
    if (!record) {
      record = {
        // TODO buffer user data and keep track of sequence numbers
        received: new BigNumber(0),
        expected: new BigNumber(0),
        finished: false
      }
      payments[paymentId] = record
    }
    record.expected = request.paymentAmount

    function rejectTransfer (message) {
      debug(`rejecting transfer ${transfer.id} (part of payment: ${paymentId}): ${message}`)
      err = new Error(message)
      err.name = 'InterledgerRejectionError'
      const data = serializePskPacket({
        sharedSecret,
        type: constants.TYPE_ERROR,
        paymentId: request.paymentId,
        sequence: request.sequence,
        paymentAmount: record.received,
        chunkAmount: new BigNumber(transfer.amount)
      })
      err.ilpRejection = IlpPacket.serializeIlpRejection({
        code: 'F99',
        triggeredBy: '',
        message: '',
        data
      })
      throw err
    }

    // Transfer amount too low
    if (request.chunkAmount.gt(transfer.amount)) {
      return rejectTransfer(`incoming transfer amount too low. actual: ${transfer.amount}, expected: ${request.chunkAmount.toString(10)}`)
    }

    // Already received enough
    if (record.received.gte(record.expected)) {
      return rejectTransfer(`already received enough for payment. received: ${record.received.toString(10)}, expected: ${record.expected.toString(10)}`)
    }

    // Chunk is too much
    if (record.received.plus(transfer.amount).gt(record.expected.times(acceptableOverpaymentMultiple))) {
      return rejectTransfer(`incoming transfer would put the payment too far over the expected amount. already received: ${record.received.toString(10)}, expected: ${record.expected.toString(10)}, transfer amount: ${transfer.amount}`)
    }

    // Check if we can regenerate the correct fulfillment
    let fulfillment
    try {
      fulfillment = dataToFulfillment(secret, packet.data)
      const generatedCondition = fulfillmentToCondition(fulfillment)
      assert(generatedCondition.equals(transfer.executionCondition), 'condition generated does not match')
    } catch (err) {
      err = new Error('wrong condition')
      err.name = 'InterledgerRejectionError'
      err.ilpRejection = IlpPacket.serializeIlpRejection({
        code: 'F05',
        message: err.message,
        data: Buffer.alloc(0),
        triggeredBy: ''
      })
      throw err
    }

    // Update stats based on that chunk
    record.received = record.received.plus(transfer.amount)
    if (record.received.gte(record.expected) || request.type === constants.TYPE_LAST_CHUNK) {
      record.finished = true
    }

    const response = serializePskPacket({
      sharedSecret: secret,
      type: constants.TYPE_FULFILLMENT,
      paymentId: request.paymentId,
      sequence: request.sequence,
      paymentAmount: record.received,
      chunkAmount: new BigNumber(transfer.amount)
    })

    debug(`got ${record.finished ? 'last ' : ''}chunk of amount ${transfer.amount} for payment: ${paymentId}. total received: ${record.received.toString(10)}`)

    debug(`fulfilling transfer: ${fulfillment.toString('base64')}`)

    return {
      fulfillment,
      ilp: response
    }
  }
}

exports.listen = listen
