'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Debug = require('debug')
const BigNumber = require('bignumber.js')
const IlpPacket = require('ilp-packet')
const convertToV2Plugin = require('ilp-compat-plugin')
const constants = require('./constants')
const { serializePskPacket, deserializePskPacket } = require('./encoding')
const { dataToFulfillment, fulfillmentToCondition } = require('./condition')

const DEFAULT_TRANSFER_TIMEOUT = 2000
const STARTING_TRANSFER_AMOUNT = 1000
const TRANSFER_INCREASE = 1.1
const TRANSFER_DECREASE = 0.5

async function quote (plugin, {
  sourceAmount,
  destinationAmount,
  sharedSecret,
  destinationAccount,
  quoteId = crypto.randomBytes(16)
}) {
  plugin = convertToV2Plugin(plugin)
  const debug = Debug('ilp-psk2:quote')
  assert(sharedSecret, 'sharedSecret is required')
  assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(sourceAmount || destinationAmount, 'either sourceAmount or destinationAmount is required')
  assert(!sourceAmount || !destinationAmount, 'cannot supply both sourceAmount and destinationAmount')
  assert(!quoteId || (Buffer.isBuffer(quoteId) && quoteId.length === 16), 'quoteId must be a 16-byte buffer if supplied')

  const sequence = 0
  const data = serializePskPacket({
    sharedSecret,
    // TODO should this be the last chunk? what if you want to use the same id for the quote and payment?
    type: constants.TYPE_LAST_CHUNK,
    paymentId: quoteId,
    sequence,
    paymentAmount: constants.MAX_UINT64,
    // Setting the chunk amount to the max will cause the receiver to
    // reject the chunk (though we also make the condition unfulfillable
    // to ensure that they cannot fulfill the chunk)
    chunkAmount: constants.MAX_UINT64
  })
  const ilp = IlpPacket.serializeIlpForwardedPayment({
    account: destinationAccount,
    data
  })

  const amount = sourceAmount || STARTING_TRANSFER_AMOUNT
  const transfer = {
    amount,
    // Unfulfillable condition
    executionCondition: crypto.randomBytes(32),
    expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT).toISOString(),
    ilp
  }

  try {
    await plugin.sendTransfer(transfer)
  } catch (err) {
    if (!err.ilpRejection) {
      throw err
    }

    let amountArrived
    try {
      const rejection = IlpPacket.deserializeIlpRejection(err.ilpRejection)
      const quoteResponse = deserializePskPacket(sharedSecret, rejection.data)

      // Validate that this is actually the response to our request
      assert(quoteResponse.type === constants.TYPE_ERROR, 'response type must be error')
      assert(quoteId.equals(quoteResponse.paymentId), 'response Payment ID does not match outgoing quote')
      assert(sequence === quoteResponse.sequence, 'sequence does not match outgoing quote')

      amountArrived = quoteResponse.chunkAmount
    } catch (decryptionErr) {
      debug('error parsing encrypted quote response', decryptionErr, err.ilpRejection.toString('base64'))
      throw err
    }

    debug(`receiver got: ${amountArrived.toString(10)} when sender sent: ${amount} (rate: ${amountArrived.div(amount).toString(10)})`)
    if (sourceAmount) {
      return {
        id: quoteId.toString('hex'),
        sourceAmount,
        destinationAmount: amountArrived.toString(10)
      }
    } else {
      const sourceAmount = new BigNumber(destinationAmount)
        .div(amountArrived)
        .times(STARTING_TRANSFER_AMOUNT)
        .round(0, BigNumber.ROUND_UP)
        // TODO should we always round up or just half up?
      return {
        id: quoteId.toString('hex'),
        sourceAmount: sourceAmount.toString(10),
        destinationAmount
      }
    }
  }
}

async function sendSingleChunk (plugin, {
  sourceAmount,
  sharedSecret,
  destinationAccount,
  minDestinationAmount = 0,
  paymentId = crypto.randomBytes(16)
}) {
  plugin = convertToV2Plugin(plugin)
  const debug = Debug('ilp-psk2:singleChunk')

  assert(sharedSecret, 'sharedSecret is required')
  assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(sourceAmount, 'sourceAmount is required')
  assert(!paymentId || (Buffer.isBuffer(paymentId) && paymentId.length === 16), 'paymentId must be a 16-byte buffer if supplied')

  debug(`sending single chunk payment ${paymentId.toString('hex')} with source amount: ${sourceAmount} and minimum destination amount: ${minDestinationAmount}`)

  const sequence = 0
  const data = serializePskPacket({
    sharedSecret,
    type: constants.TYPE_LAST_CHUNK,
    paymentId,
    sequence,
    // We don't set the paymentAmount to the minDestinationAmount just in case
    // we deliver slightly too much (for example because of rounding issues) and we
    // don't want the receiver to reject the transfer because of this
    paymentAmount: constants.MAX_UINT64,
    chunkAmount: new BigNumber(minDestinationAmount)
  })
  const ilp = IlpPacket.serializeIlpForwardedPayment({
    account: destinationAccount,
    data
  })

  const fulfillment = dataToFulfillment(sharedSecret, data)
  const executionCondition = fulfillmentToCondition(fulfillment)

  const transfer = {
    ilp,
    amount: new BigNumber(sourceAmount).toString(10),
    expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT).toISOString(),
    executionCondition
  }

  let result
  try {
    result = await plugin.sendTransfer(transfer)
  } catch (err) {
    // TODO handle timeout errors
    if (err.name !== 'InterledgerRejectionError' || !err.ilpRejection) {
      debug('error sending transfer:', err)
      throw err
    }

    let rejection
    try {
      rejection = IlpPacket.deserializeIlpRejection(err.ilpRejection)
      err.message = `${rejection.code}: ${rejection.message || err.message}`
    } catch (e) {
      // Just throw the error normally if we can't parse the rejection
    }
    throw err
  }

  assert(fulfillment.equals(result.fulfillment), `received invalid fulfillment. expected: ${fulfillment.toString('base64')}, actual: ${result.fulfillment.toString('base64')}`)

  let amountArrived
  try {
    const response = deserializePskPacket(sharedSecret, result.ilp)

    assert(constants.TYPE_FULFILLMENT === response.type, `unexpected packet type. expected: ${constants.TYPE_FULFILLMENT}, actual: ${response.type}`)
    assert(paymentId.equals(response.paymentId), `response does not correspond to request. payment id does not match. actual: ${response.paymentId.toString('hex')}, expected: ${paymentId.toString('hex')}`)
    assert(sequence === response.sequence, `response does not correspond to request. sequence does not match. actual: ${response.sequence}, expected: ${sequence}`)

    amountArrived = response.chunkAmount
  } catch (err) {
    debug('got invalid response:', err, JSON.stringify(result))
    throw new Error('Invalid response from receiver: ' + err.message)
  }

  debug(`sent single chunk payment ${paymentId.toString('hex')} with source amount: ${sourceAmount}, destination amount: ${amountArrived.toString(10)}`)

  return {
    id: paymentId.toString('hex'),
    sourceAmount,
    destinationAmount: amountArrived.toString(10)
  }
}

async function send (plugin, {
  sourceAmount,
  sharedSecret,
  destinationAccount,
  paymentId
}) {
  assert(sharedSecret, 'sharedSecret is required')
  assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(sourceAmount, 'sourceAmount is required')
  assert(!paymentId || (Buffer.isBuffer(paymentId) && paymentId.length === 16), 'paymentId must be a 16-byte buffer if supplied')
  return sendChunkedPayment(plugin, { sourceAmount, sharedSecret, destinationAccount })
}

async function deliver (plugin, {
  destinationAmount,
  sharedSecret,
  destinationAccount,
  paymentId
}) {
  assert(sharedSecret, 'sharedSecret is required')
  assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(destinationAmount, 'destinationAmount is required')
  assert(!paymentId || (Buffer.isBuffer(paymentId) && paymentId.length === 16), 'paymentId must be a 16-byte buffer if supplied')
  return sendChunkedPayment(plugin, { destinationAmount, sharedSecret, destinationAccount })
}

// TODO add option not to chunk the payment
// TODO accept user data also
async function sendChunkedPayment (plugin, {
  sharedSecret,
  destinationAccount,
  sourceAmount,
  destinationAmount,
  paymentId = crypto.randomBytes(16)
}) {
  plugin = convertToV2Plugin(plugin)
  const debug = Debug('ilp-psk2:chunkedPayment')

  let amountSent = new BigNumber(0)
  let amountDelivered = new BigNumber(0)
  let sequence = 0
  let chunkSize = new BigNumber(STARTING_TRANSFER_AMOUNT)
  let lastChunk = false
  let timeToWait = 0
  let rate = new BigNumber(0)

  function handleReceiverResponse ({ encrypted, expectedType, expectedSequence }) {
    try {
      const response = deserializePskPacket(sharedSecret, encrypted)

      assert(expectedType === response.type, `unexpected packet type. expected: ${expectedType}, actual: ${response.type}`)
      assert(paymentId.equals(response.paymentId), `response does not correspond to request. payment id does not match. actual: ${response.paymentId.toString('hex')}, expected: ${paymentId.toString('hex')}`)
      assert(expectedSequence === response.sequence, `response does not correspond to request. sequence does not match. actual: ${response.sequence}, expected: ${sequence - 1}`)

      const amountReceived = response.paymentAmount
      debug(`receiver says they have received: ${amountReceived.toString(10)}`)
      if (amountReceived.gt(amountDelivered)) {
        amountDelivered = amountReceived
        rate = amountDelivered.div(amountSent)
      } else {
        // TODO should we throw a more serious error here?
        debug(`receiver decreased the amount they say they received. previously: ${amountDelivered.toString(10)}, now: ${amountReceived.toString(10)}`)
      }
    } catch (err) {
      debug('error decrypting response data:', err, encrypted.toString('base64'))
      throw new Error('Got bad response from receiver: ' + err.message)
    }
  }

  while (true) {
    // Figure out if we've sent enough already
    let amountLeftToSend
    if (sourceAmount) {
      // Fixed source amount
      amountLeftToSend = new BigNumber(sourceAmount).minus(amountSent)
      debug(`amount left to send: ${amountLeftToSend.toString(10)}`)
    } else {
      // Fixed destination amount
      const amountLeftToDeliver = new BigNumber(destinationAmount).minus(amountDelivered)
      if (amountLeftToDeliver.lte(0)) {
        debug('amount left to deliver: 0')
        break
      }
      // Use the path exchange rate to figure out the amount left to send
      if (amountSent.gt(0)) {
        const rate = amountDelivered.div(amountSent)
        amountLeftToSend = amountLeftToDeliver.div(rate).round(0, BigNumber.ROUND_CEIL) // round up
        debug(`amount left to send: ${amountLeftToSend.toString(10)} (amount left to deliver: ${amountLeftToDeliver.toString(10)}, rate: ${rate.toString(10)})`)
      } else {
        // We don't know how much more we need to send
        amountLeftToSend = constants.MAX_UINT64
        debug('amount left to send: unknown')
      }
    }

    // Stop if we've already sent enough
    if (amountLeftToSend.lte(0)) {
      break
    }

    // If there's only one more chunk to send, communicate that to the receiver
    if (amountLeftToSend.lte(chunkSize)) {
      debug('sending last chunk')
      chunkSize = amountLeftToSend
      lastChunk = true
    }

    // TODO should we allow the rate to fluctuate more?
    const minimumAmountReceiverShouldAccept = rate.times(chunkSize)

    const data = serializePskPacket({
      sharedSecret,
      type: (lastChunk ? constants.TYPE_LAST_CHUNK : constants.TYPE_CHUNK),
      paymentId,
      sequence,
      paymentAmount: (destinationAmount ? new BigNumber(destinationAmount) : constants.MAX_UINT64),
      chunkAmount: minimumAmountReceiverShouldAccept
    })
    const ilp = IlpPacket.serializeIlpForwardedPayment({
      account: destinationAccount,
      data
    })

    const fulfillment = dataToFulfillment(sharedSecret, data)
    const executionCondition = fulfillmentToCondition(fulfillment)

    debug(`sending chunk of: ${chunkSize.toString(10)}`)
    const transfer = {
      ilp,
      amount: chunkSize.toString(10),
      expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT).toISOString(),
      executionCondition
    }

    try {
      const result = await plugin.sendTransfer(transfer)
      amountSent = amountSent.plus(transfer.amount)

      handleReceiverResponse({
        encrypted: result.ilp,
        expectedType: constants.TYPE_FULFILLMENT,
        expectedSequence: sequence
      })

      chunkSize = chunkSize.times(TRANSFER_INCREASE).round(0)
      debug('transfer was successful, increasing chunk size to:', chunkSize.toString(10))
      timeToWait = 0

      if (lastChunk) {
        break
      } else {
        sequence++
      }
    } catch (err) {
      if (err.name !== 'InterledgerRejectionError' || !err.ilpRejection) {
        debug('got error other than an InterledgerRejectionError:', err)
        throw err
      }

      let ilpRejection
      try {
        ilpRejection = IlpPacket.deserializeIlpRejection(err.ilpRejection)
      } catch (err) {
        debug('error parsing IlpRejection from receiver:', err && err.stack)
        throw new Error('Error parsing IlpRejection from receiver: ' + err.message)
      }

      if (ilpRejection.code === 'F99') {
        // Handle if the receiver rejects the transfer with a PSK packet
        handleReceiverResponse({
          encrypted: ilpRejection.data,
          expectedType: constants.TYPE_ERROR,
          expectedSequence: sequence
        })
      } else if (ilpRejection.code[0] === 'T' || ilpRejection.code[0] === 'R') {
        // Handle temporary and relative errors
        // TODO is this the right behavior in this situation?
        // TODO don't retry forever
        chunkSize = chunkSize
          .times(TRANSFER_DECREASE)
          .round(0)
        if (chunkSize.lt(1)) {
          chunkSize = new BigNumber(1)
        }
        timeToWait = Math.max(timeToWait * 2, 100)
        debug(`got temporary ILP rejection: ${ilpRejection.code}, reducing chunk size to: ${chunkSize.toString(10)} and waiting: ${timeToWait}ms`)
        await new Promise((resolve, reject) => setTimeout(resolve, timeToWait))
      } else {
        // TODO is it ever worth retrying here?
        debug('got ILP rejection with final error:', JSON.stringify(ilpRejection))
        throw new Error(`Transfer rejected with final error: ${ilpRejection.code}${(ilpRejection.message ? ': ' + ilpRejection.message : '')}`)
      }
    }
  }

  debug(`sent payment. source amount: ${amountSent.toString(10)}, destination amount: ${amountDelivered.toString(10)}, number of chunks: ${sequence + 1}`)

  return {
    id: paymentId.toString('hex'),
    sourceAmount: amountSent.toString(10),
    destinationAmount: amountDelivered.toString(10),
    numChunks: sequence + 1
  }
}

exports.quote = quote
exports.sendSingleChunk = sendSingleChunk
exports.send = send
exports.deliver = deliver
