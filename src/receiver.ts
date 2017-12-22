'use strict'

import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
const debug = Debug('ilp-psk2:receiver')
import BigNumber from 'bignumber.js'
import { default as convertToV2Plugin, TransferV2, InterledgerRejectionError } from 'ilp-compat-plugin'
import IlpPacket = require('ilp-packet')
import * as constants from './constants'
import { serializePskPacket, deserializePskPacket, PskPacket } from './encoding'
import { dataToFulfillment, fulfillmentToCondition } from './condition'

const RECEIVER_ID_STRING = 'ilp_psk2_receiver_id'
const PSK_GENERATION_STRING = 'ilp_psk2_generation'
const RECEIVER_ID_LENGTH = 8
const TOKEN_LENGTH = 18
const SHARED_SECRET_LENGTH = 32

export interface ListenOpts {
  receiverSecret: Buffer,
  acceptableOverpaymentMultiple?: number
}

export interface ReviewCallback {
  (opts: ReviewCallbackOpts): Promise<boolean>
}

export interface ReviewCallbackOpts {
  paymentId: string,
  expectedAmount: string,
  accept: () => Promise<{}>,
  reject: () => void
}

export interface FulfillmentInfo {
  fulfillment: Buffer,
  ilp: Buffer
}

export interface PaymentResult {
  id: string,
  receivedAmount: string,
  expectedAmount: string,
  chunksFulfilled: number
}

export function listen (plugin: any, opts: ListenOpts, callback: ReviewCallback): () => void {
  // TODO add option to notify receiver about every incoming chunk?
  plugin = convertToV2Plugin(plugin)
  const {
    receiverSecret,
    acceptableOverpaymentMultiple = 1.01
  } = opts

  assert(receiverSecret, 'receiverSecret is required')
  assert(receiverSecret.length >= 32, 'receiverSecret must be at least 32 bytes')
  assert(typeof callback === 'function', 'review callback must be a function')

  const receiverId = getReceiverId(receiverSecret)
  // TODO replace plugin.getAccount() with Interledger "DHCP" call
  const account = plugin.getAccount()

  const payments = {}

  plugin.registerTransferHandler(handlePrepare)

  function throwError (code: string, message: string, data?: Buffer): void {
    debug('rejecting transfer:', code, message)
    const err = new InterledgerRejectionError(message,
      IlpPacket.serializeIlpRejection({
        code,
        message,
        data: data || Buffer.alloc(0),
        triggeredBy: account
      }))
    throw err
  }

  async function handlePrepare (transfer: TransferV2): Promise<FulfillmentInfo|void> {
    let packet
    let sharedSecret: Buffer
    let err
    try {
      packet = IlpPacket.deserializeIlpForwardedPayment(transfer.ilp)
      const parsedAccount = parseAccount(packet.account)

      // assert(parsedAccount.destinationAccount === account, 'payment is for a different destination account')
      assert(parsedAccount.receiverId === receiverId, 'payment is for a different receiver')

      sharedSecret = generateSharedSecret(receiverSecret, parsedAccount.token)
    } catch (err) {
      // If this transfer isn't for us, we'll wait until right before the expiry and then reject it
      // in case there is another listener that is expecting it
      const timeout = Date.parse(transfer.expiresAt) - Date.now() - 100
      debug(`transfer is not for us, waiting ${timeout}ms to reject it:`, err.message)
      await new Promise((resolve, reject) => setTimeout(resolve, timeout))
      return throwError('F05', 'unable to decrypt data')
    }

    let request: PskPacket
    try {
      request = deserializePskPacket(sharedSecret, packet.data)
    } catch (err) {
      debug('error decrypting data:', err)
      return throwError('F06', 'unable to decrypt data')
    }

    if (request.type !== constants.TYPE_CHUNK && request.type !== constants.TYPE_LAST_CHUNK) {
      debug(`got unexpected request type: ${request.type}`)
      return throwError('F06', 'unexpected request type')
    }

    const paymentId = request.paymentId.toString('hex')
    let record = payments[paymentId]
    if (!record) {
      record = {
        // TODO buffer user data and keep track of sequence numbers
        received: new BigNumber(0),
        expected: new BigNumber(0),
        finished: false,
        finishedPromise: null,
        acceptedByReceiver: null,
        chunksFulfilled: 0,
        chunksRejected: 0 // doesn't include chunks we cannot parse
      }
      payments[paymentId] = record
    }
    record.expected = request.paymentAmount

    function rejectTransfer (message: string) {
      debug(`rejecting transfer ${request.sequence} of payment ${paymentId}: ${message}`)
      record.chunksRejected += 1
      const data = serializePskPacket(
        sharedSecret,
      {
        type: constants.TYPE_ERROR,
        paymentId: request.paymentId,
        sequence: request.sequence,
        paymentAmount: record.received,
        chunkAmount: new BigNumber(transfer.amount)
      })
      err = new InterledgerRejectionError(message, 
        IlpPacket.serializeIlpRejection({
          code: 'F99',
          triggeredBy: plugin.getAccount(),
          message: '',
          data
        }))
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

    // Check if the receiver wants to accept the payment
    if (record.acceptedByReceiver === null) {
      try {
        await new Promise((resolve, reject) => {
          callback({
            paymentId,
            expectedAmount: record.expected.toString(10),
            accept: async () => {
              await resolve()
              // The promise returned to the receiver will be fulfilled
              // when the whole payment is finished
              return new Promise((resolve, reject) => {
                record.finishedPromise = { resolve, reject }
                // TODO should the payment timeout after some time?
              })
            },
            reject: reject
            // TODO include first chunk data
          })
        })
      } catch (err) {
        record.acceptedByReceiver = false
        record.rejectionMessage = err && err.message
      }
    }

    // Reject the chunk if the receiver didn't want the payment
    if (record.acceptedByReceiver === false) {
      record.chunksRejected += 1
      return throwError('F99', 'rejected by receiver' + (record.rejectionMessage ? ': ' + record.rejectionMessage : ''))
    }

    // Check if we can regenerate the correct fulfillment
    let fulfillment
    try {
      fulfillment = dataToFulfillment(sharedSecret, packet.data)
      const generatedCondition = fulfillmentToCondition(fulfillment)
      assert(generatedCondition.equals(transfer.executionCondition), `condition generated does not match. expected: ${transfer.executionCondition.toString('base64')}, actual: ${generatedCondition.toString('base64')}`)
    } catch (err) {
      debug('error regenerating fulfillment:', err)
      record.chunksRejected += 1
      return throwError('F05', 'condition generated does not match')
    }

    record.chunksFulfilled += 1
    debug(`got ${record.finished ? 'last ' : ''}chunk of amount ${transfer.amount} for payment: ${paymentId}. total received: ${record.received.toString(10)}`)

    // Update stats based on that chunk
    record.received = record.received.plus(transfer.amount)
    if (record.received.gte(record.expected) || request.type === constants.TYPE_LAST_CHUNK) {
      record.finished = true
      record.finishedPromise.resolve({
        id: paymentId,
        receivedAmount: record.received.toString(10),
        expectedAmount: record.expected.toString(10),
        chunksFulfilled: record.chunksFulfilled
        // TODO add data
        // TODO report rejected chunks?
      })
    }

    // Let the sender know how much has arrived
    const response = serializePskPacket(sharedSecret, {
      type: constants.TYPE_FULFILLMENT,
      paymentId: request.paymentId,
      sequence: request.sequence,
      paymentAmount: record.received,
      chunkAmount: new BigNumber(transfer.amount)
    })

    debug(`fulfilling transfer ${request.sequence} for payment ${paymentId} with fulfillment: ${fulfillment.toString('base64')}`)

    return {
      fulfillment,
      ilp: response
    }
  }

  return () => {
    debug('stop listening')
    plugin.deregisterTransferHandler()
  }
}

export interface PskParams {
  sharedSecret: Buffer,
  destinationAccount: string
}

export interface GenerateParamsOpts {
  destinationAccount: string,
  receiverSecret: Buffer
}

export function generateParams (opts: GenerateParamsOpts): PskParams {
  const {
    destinationAccount,
    receiverSecret
  } = opts
  assert(typeof destinationAccount === 'string', 'destinationAccount must be a string')
  assert(Buffer.isBuffer(receiverSecret), 'receiverSecret must be a buffer')

  const token = base64url(crypto.randomBytes(TOKEN_LENGTH))
  const receiverId = getReceiverId(receiverSecret)
  const sharedSecret = generateSharedSecret(receiverSecret, token)

  return {
    sharedSecret,
    destinationAccount: `${destinationAccount}.${receiverId}.${token}`
  }
}

function parseAccount (destinationAccount: string): { destinationAccount: string, receiverId: string, token: string } {
  const split = destinationAccount.split('.')
  assert(split.length >= 2, 'account must have receiverId and token components')
  const receiverId = split[split.length - 2]
  const token = split[split.length - 1]
  return {
    destinationAccount: split.slice(0, split.length - 2).join('.'),
    receiverId,
    token
  }
}

function getReceiverId (receiverSecret: Buffer): string {
  const buf = hmac(receiverSecret, Buffer.from(RECEIVER_ID_STRING, 'utf8')).slice(0, RECEIVER_ID_LENGTH)
  return base64url(buf)
}

function generateSharedSecret (secret: Buffer, token: string): Buffer {
  const sharedSecretGenerator = hmac(secret, Buffer.from(PSK_GENERATION_STRING, 'utf8'))
  return hmac(sharedSecretGenerator, Buffer.from(token, 'base64')).slice(0, SHARED_SECRET_LENGTH)
}

function hmac (key: Buffer, message: Buffer): Buffer {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

function base64url (buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}