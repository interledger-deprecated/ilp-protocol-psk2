import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
import BigNumber from 'bignumber.js'
import * as IlpPacket from 'ilp-packet'
import { default as convert, PluginV1, PluginV2 } from 'ilp-compat-plugin'
import * as constants from './constants'
import { serializePskPacket, deserializePskPacket, PskPacket } from './encoding'
import { dataToFulfillment, fulfillmentToCondition } from './condition'

const DEFAULT_TRANSFER_TIMEOUT = 2000
const STARTING_TRANSFER_AMOUNT = 1000
const TRANSFER_INCREASE = 1.1
const TRANSFER_DECREASE = 0.5

// Chunked payments are still experimental so we want to warn the user (but only once per use of the module)
let warnedUserAboutChunkedPayments = false

export interface QuoteSourceParams {
  sourceAmount: BigNumber | string | number,
  sharedSecret: Buffer,
  destinationAccount: string,
  id?: Buffer
}

export interface QuoteDestinationParams {
  destinationAmount: BigNumber | string | number,
  sharedSecret: Buffer,
  destinationAccount: string,
  id?: Buffer
}

export interface QuoteResult {
  id: string,
  sourceAmount: string,
  destinationAmount: string
}

export async function quoteSourceAmount (plugin: PluginV2 | PluginV1, params: QuoteSourceParams) {
  let {
    sourceAmount,
    sharedSecret,
    destinationAccount,
    id = crypto.randomBytes(16)
  } = params
  sourceAmount = new BigNumber(sourceAmount)
  assert(sourceAmount.isInteger(), 'sourceAmount must be an integer')
  assert(sharedSecret, 'sharedSecret is required')
  assert(sharedSecret.length >= 32, 'sharedSecret must be at least 32 bytes')
  /* tslint:disable-next-line:strict-type-predicates */
  assert(destinationAccount && typeof destinationAccount === 'string', 'destinationAccount is required')
  assert((Buffer.isBuffer(id) && id.length === 16), 'id must be a 16-byte buffer')
  return quote(plugin, sharedSecret, id, destinationAccount, sourceAmount, undefined)
}

export async function quoteDestinationAmount (plugin: PluginV2 | PluginV1, params: QuoteDestinationParams) {
  let {
    destinationAmount,
    sharedSecret,
    destinationAccount,
    id = crypto.randomBytes(16)
  } = params
  destinationAmount = new BigNumber(destinationAmount)
  assert(destinationAmount.isInteger(), 'destinationAmount must be an integer')
  assert(sharedSecret, 'sharedSecret is required')
  assert(sharedSecret.length >= 32, 'sharedSecret must be at least 32 bytes')
  /* tslint:disable-next-line:strict-type-predicates */
  assert(destinationAccount && typeof destinationAccount === 'string', 'destinationAccount is required')
  assert((Buffer.isBuffer(id) && id.length === 16), 'id must be a 16-byte buffer if supplied')
  return quote(plugin, sharedSecret, id, destinationAccount, undefined, destinationAmount)
}

async function quote (
  plugin: PluginV2 | PluginV1,
  sharedSecret: Buffer,
  id: Buffer,
  destinationAccount: string,
  sourceAmount?: BigNumber,
  destinationAmount?: BigNumber
): Promise<QuoteResult> {
  plugin = convert(plugin)
  const debug = Debug('ilp-psk2:quote')

  const sequence = 0
  const data = serializePskPacket(
    sharedSecret, {
      // TODO should this be the last chunk? what if you want to use the same id for the quote and payment?
      type: constants.TYPE_LAST_CHUNK,
      paymentId: id,
      sequence,
      paymentAmount: constants.MAX_UINT64,
      // Setting the chunk amount to the max will cause the receiver to
      // reject the chunk (though we also make the condition unfulfillable
      // to ensure that they cannot fulfill the chunk)
      chunkAmount: constants.MAX_UINT64
    })
  const amount = new BigNumber(sourceAmount || STARTING_TRANSFER_AMOUNT).toString(10)
  const ilp = IlpPacket.serializeIlpPrepare({
    destination: destinationAccount,
    amount,
    executionCondition: crypto.randomBytes(32),
    expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT),
    data
  })

  let amountArrived = new BigNumber(0)
  const result = await plugin.sendData(ilp)
  let rejection
  try {
    rejection = IlpPacket.deserializeIlpReject(result)
    assert(rejection.code === 'F99', `Got unexpected error code: ${rejection.code} ${rejection.message}`)
    assert(rejection.data.length > 0, 'Got empty response data')
  } catch (err) {
    debug('error deserializing quote response:', err)
    throw new Error('Error getting quote: ' + err.message)
  }

  try {
    const quoteResponse = deserializePskPacket(sharedSecret, rejection.data)

    // Validate that this is actually the response to our request
    assert(quoteResponse.type === constants.TYPE_ERROR, 'response type must be error')
    assert(id.equals(quoteResponse.paymentId), 'response Payment ID does not match outgoing quote')
    assert(sequence === quoteResponse.sequence, 'sequence does not match outgoing quote')

    amountArrived = quoteResponse.chunkAmount
  } catch (decryptionErr) {
    debug('error parsing encrypted quote response', decryptionErr, result.toString('base64'))
    throw new Error('unable to parse quote response')
  }

  debug(`receiver got: ${amountArrived.toString(10)} when sender sent: ${amount} (rate: ${amountArrived.div(amount).toString(10)})`)
  let quotedSourceAmount
  let quotedDestinationAmount
  if (sourceAmount) {
    quotedSourceAmount = new BigNumber(sourceAmount)
    quotedDestinationAmount = amountArrived
  } else {
    quotedSourceAmount = new BigNumber(destinationAmount as BigNumber)
      .div(amountArrived)
      .times(STARTING_TRANSFER_AMOUNT)
      .round(0, BigNumber.ROUND_UP)
    // TODO should we always round up or just half up?
    quotedDestinationAmount = new BigNumber(destinationAmount as BigNumber)
  }
  return {
    id: id.toString('hex'),
    sourceAmount: quotedSourceAmount.toString(10),
    destinationAmount: quotedDestinationAmount.toString(10)
  }
}

export interface SendSingleChunkParams {
  sourceAmount: BigNumber | string | number,
  sharedSecret: Buffer,
  destinationAccount: string,
  minDestinationAmount?: BigNumber | string | number,
  id?: Buffer,
  sequence?: number,
  lastChunk?: boolean
}

export interface SendResult {
  id: string,
  sourceAmount: string,
  destinationAmount: string,
  chunksFulfilled: number,
  chunksRejected: number
}

export async function sendSingleChunk (plugin: any, params: SendSingleChunkParams): Promise<SendResult> {
  plugin = convert(plugin)
  const debug = Debug('ilp-psk2:singleChunk')
  const {
    sourceAmount,
    sharedSecret,
    destinationAccount,
    minDestinationAmount = 0,
    id = crypto.randomBytes(16),
    sequence = 0,
    lastChunk = true
  } = params

  assert(sharedSecret, 'sharedSecret is required')
  assert(sharedSecret.length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(sourceAmount, 'sourceAmount is required')
  assert(!id || (Buffer.isBuffer(id) && id.length === 16), 'id must be a 16-byte buffer if supplied')

  debug(`sending single chunk payment ${id.toString('hex')} with source amount: ${sourceAmount} and minimum destination amount: ${minDestinationAmount}`)

  const data = serializePskPacket(sharedSecret, {
    type: (lastChunk ? constants.TYPE_LAST_CHUNK : constants.TYPE_CHUNK),
    paymentId: id,
    sequence,
    // We don't set the paymentAmount to the minDestinationAmount just in case
    // we deliver slightly too much (for example because of rounding issues) and we
    // don't want the receiver to reject the transfer because of this
    paymentAmount: constants.MAX_UINT64,
    chunkAmount: new BigNumber(minDestinationAmount)
  })
  const fulfillment = dataToFulfillment(sharedSecret, data)
  const executionCondition = fulfillmentToCondition(fulfillment)
  const ilp = IlpPacket.serializeIlpPrepare({
    destination: destinationAccount,
    amount: new BigNumber(sourceAmount).toString(10),
    executionCondition,
    expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT),
    data
  })

  const result = await plugin.sendData(ilp)

  let parsed
  try {
    parsed = IlpPacket.deserializeIlpPacket(result)
  } catch (err) {
    debug('error parsing sendData response:', err, 'response:', result.toString('base64'))
    throw err
  }

  let fulfillmentInfo: IlpPacket.IlpFulfill
  if (parsed.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    fulfillmentInfo = parsed.data as IlpPacket.IlpFulfill
  } else if (parsed.type === IlpPacket.Type.TYPE_ILP_REJECT) {
    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    const rejection: IlpPacket.IlpRejection = parsed.data as IlpPacket.IlpRejection
    // TODO throw specific error if the receiver says they received too little
    // TODO use ILP error code string
    debug('error sending payment:', JSON.stringify(rejection))
    throw new Error(`Error sending payment. code: ${rejection.code}, message: ${rejection.message} `)
  } else {
    debug('sendData returned unexpected packet type:', JSON.stringify(parsed))
    throw new Error('Unexpected type for sendData response: ' + parsed.type)
  }

  if (!fulfillment.equals(fulfillmentInfo.fulfillment)) {
    debug(`Received invalid fulfillment. expected: ${fulfillment.toString('base64')}, actual: ${fulfillmentInfo.fulfillment.toString('base64')}`)
    throw new Error(`Received invalid fulfillment. expected: ${fulfillment.toString('base64')}, actual: ${fulfillmentInfo.fulfillment.toString('base64')}`)
  }

  let amountArrived
  try {
    const response = deserializePskPacket(sharedSecret, fulfillmentInfo.data)

    assert(constants.TYPE_FULFILLMENT === response.type, `unexpected PSK packet type. expected: ${constants.TYPE_FULFILLMENT}, actual: ${response.type}`)
    assert(id.equals(response.paymentId), `response does not correspond to request. payment id does not match. actual: ${response.paymentId.toString('hex')}, expected: ${id.toString('hex')}`)
    assert(sequence === response.sequence, `response does not correspond to request. sequence does not match. actual: ${response.sequence}, expected: ${sequence}`)

    amountArrived = response.chunkAmount
  } catch (err) {
    debug('got invalid response:', err, JSON.stringify(result))
    throw new Error('Invalid response from receiver: ' + err.message)
  }

  debug(`sent single chunk payment ${id.toString('hex')} with source amount: ${sourceAmount}, destination amount: ${amountArrived.toString(10)}`)

  return {
    // TODO should this be a buffer or string?
    id: id.toString('hex'),
    sourceAmount: new BigNumber(sourceAmount).toString(10),
    destinationAmount: amountArrived.toString(10),
    chunksFulfilled: 1,
    chunksRejected: 0
  }
}

export interface SendSourceParams {
  sourceAmount: BigNumber | string | number,
  sharedSecret: Buffer,
  destinationAccount: string,
  id?: Buffer
}

export async function sendSourceAmount (plugin: any, params: SendSourceParams): Promise<SendResult> {
  assert(params.sourceAmount, 'sourceAmount is required')
  return sendChunkedPayment(plugin, params)
}

export interface SendDestinationParams {
  destinationAmount: BigNumber | string | number,
  sharedSecret: Buffer,
  destinationAccount: string,
  id?: Buffer
}

export async function sendDestinationAmount (plugin: any, params: SendDestinationParams): Promise<SendResult> {
  assert(params.destinationAmount, 'destinationAmount is required')
  return sendChunkedPayment(plugin, params)
}

interface ChunkedPaymentParams {
  sharedSecret: Buffer,
  destinationAccount: string,
  sourceAmount?: BigNumber | string | number,
  destinationAmount?: BigNumber | string | number,
  id?: Buffer
}

// TODO accept user data also
async function sendChunkedPayment (plugin: any, params: ChunkedPaymentParams): Promise<SendResult> {
  const {
    sharedSecret,
    destinationAccount,
    sourceAmount,
    destinationAmount,
    id = crypto.randomBytes(16)
  } = params
  assert(sharedSecret, 'sharedSecret is required')
  assert(sharedSecret.length >= 32, 'sharedSecret must be at least 32 bytes')
  assert(destinationAccount, 'destinationAccount is required')
  assert((Buffer.isBuffer(id) && id.length === 16), 'id must be a 16-byte buffer if supplied')
  plugin = convert(plugin)
  const debug = Debug('ilp-psk2:chunkedPayment')

  if (!warnedUserAboutChunkedPayments) {
    console.warn('WARNING: PSK2 Chunked Payments are experimental. Money can be lost if an error occurs mid-payment or if the exchange rate changes dramatically! This should not be used for payments that are significantly larger than the path\'s Maximum Payment Size.')
    warnedUserAboutChunkedPayments = true
  }

  let amountSent = new BigNumber(0)
  let amountDelivered = new BigNumber(0)
  let sequence = 0
  let chunkSize = new BigNumber(STARTING_TRANSFER_AMOUNT)
  let lastChunk = false
  let timeToWait = 0
  let rate = new BigNumber(0)
  let chunksFulfilled = 0
  let chunksRejected = 0

  function handleReceiverResponse (encrypted: Buffer, expectedType: number, expectedSequence: number) {
    try {
      const response = deserializePskPacket(sharedSecret, encrypted)

      assert(expectedType === response.type, `unexpected packet type. expected: ${expectedType}, actual: ${response.type}`)
      assert(id.equals(response.paymentId), `response does not correspond to request. payment id does not match. actual: ${response.paymentId.toString('hex')}, expected: ${id.toString('hex')}`)
      assert(expectedSequence === response.sequence, `response does not correspond to request. sequence does not match. actual: ${response.sequence}, expected: ${sequence - 1}`)

      const amountReceived = response.paymentAmount
      debug(`receiver says they have received: ${amountReceived.toString(10)}`)
      if (amountReceived.gte(amountDelivered)) {
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
      const amountLeftToDeliver = new BigNumber(destinationAmount || 0).minus(amountDelivered)
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
    const minimumAmountReceiverShouldAccept = BigNumber.min(
      rate.times(chunkSize).round(0, BigNumber.ROUND_DOWN),
      constants.MAX_UINT64)

    const data = serializePskPacket(sharedSecret, {
      type: (lastChunk ? constants.TYPE_LAST_CHUNK : constants.TYPE_CHUNK),
      paymentId: id,
      sequence,
      paymentAmount: (destinationAmount ? new BigNumber(destinationAmount) : constants.MAX_UINT64),
      chunkAmount: minimumAmountReceiverShouldAccept
    })
    const fulfillment = dataToFulfillment(sharedSecret, data)
    const executionCondition = fulfillmentToCondition(fulfillment)
    const prepare = IlpPacket.serializeIlpPrepare({
      destination: destinationAccount,
      amount: chunkSize.toString(10),
      expiresAt: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT),
      executionCondition,
      data
    })

    const result = await plugin.sendData(prepare)

    let parsed
    try {
      parsed = IlpPacket.deserializeIlpPacket(result)
    } catch (err) {
      debug('error parsing sendData response:', err, 'response:', result.toString('base64'))
      throw err
    }

    if (parsed.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
      const fulfill = parsed.data as IlpPacket.IlpFulfill

      if (!fulfillment.equals(fulfill.fulfillment)) {
        debug(`Received invalid fulfillment. expected: ${fulfillment.toString('base64')}, actual: ${fulfill.fulfillment.toString('base64')}`)
        throw new Error(`Received invalid fulfillment. expected: ${fulfillment.toString('base64')}, actual: ${fulfill.fulfillment.toString('base64')}`)
      }

      amountSent = amountSent.plus(chunkSize)
      handleReceiverResponse(fulfill.data, constants.TYPE_FULFILLMENT, sequence)

      chunksFulfilled += 1
      chunkSize = chunkSize.times(TRANSFER_INCREASE).round(0)
      debug('transfer was successful, increasing chunk size to:', chunkSize.toString(10))
      timeToWait = 0

      if (lastChunk) {
        break
      } else {
        sequence++
      }
    } else if (parsed.type === IlpPacket.Type.TYPE_ILP_REJECT) {
      /* tslint:disable-next-line:no-unnecessary-type-assertion */
      const rejection = parsed.data as IlpPacket.IlpRejection
      if (rejection.code === 'F99') {
        // Handle if the receiver rejects the transfer with a PSK packet
        handleReceiverResponse(
          rejection.data,
          constants.TYPE_ERROR,
          sequence)
      } else if (rejection.code[0] === 'T' || rejection.code[0] === 'R') {
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
        debug(`got temporary ILP rejection: ${rejection.code}, reducing chunk size to: ${chunkSize.toString(10)} and waiting: ${timeToWait}ms`)
        await new Promise((resolve, reject) => setTimeout(resolve, timeToWait))
      } else {
        // TODO is it ever worth retrying here?
        debug('got ILP rejection with final error:', JSON.stringify(rejection))
        throw new Error(`Transfer rejected with final error: ${rejection.code}${(rejection.message ? ': ' + rejection.message : '')}`)
      }
    } else {
      debug('sendData returned unexpected packet type:', JSON.stringify(parsed))
      throw new Error('Unexpected type for sendData response: ' + parsed.type)
    }
  }

  debug(`sent payment. source amount: ${amountSent.toString(10)}, destination amount: ${amountDelivered.toString(10)}, number of chunks: ${sequence + 1}`)

  return {
    id: id.toString('hex'),
    sourceAmount: amountSent.toString(10),
    destinationAmount: amountDelivered.toString(10),
    chunksFulfilled,
    chunksRejected
  }
}
