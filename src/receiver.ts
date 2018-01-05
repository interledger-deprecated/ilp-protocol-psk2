'use strict'

import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
const debug = Debug('ilp-psk2:receiver')
import BigNumber from 'bignumber.js'
import { default as convertToV2Plugin, PluginV1, PluginV2 } from 'ilp-compat-plugin'
import IlpPacket = require('ilp-packet')
import * as constants from './constants'
import { serializePskPacket, deserializePskPacket, PskPacket } from './encoding'
import { dataToFulfillment, fulfillmentToCondition } from './condition'
import * as ILDCP from 'ilp-protocol-ildcp'

const RECEIVER_ID_STRING = 'ilp_psk2_receiver_id'
const PSK_GENERATION_STRING = 'ilp_psk2_generation'
const RECEIVER_ID_LENGTH = 8
const TOKEN_LENGTH = 18
const SHARED_SECRET_LENGTH = 32

export interface PaymentHandler {
  (params: PaymentHandlerParams): Promise<void>
}

export interface PaymentHandlerParams {
  paymentId: string,
  expectedAmount: string,
  accept: () => Promise<PaymentReceived>,
  reject: (message: string) => void
}

export interface PaymentReceived {
  id: string,
  receivedAmount: string,
  expectedAmount: string,
  chunksFulfilled: number
}

export interface ReceiverOpts {
  plugin: PluginV2 | PluginV1,
  paymentHandler: PaymentHandler,
  secret?: Buffer
}

export async function createReceiver (opts: ReceiverOpts): Promise<Receiver> {
  if (!opts.secret) {
    opts.secret = crypto.randomBytes(32)
  }
  const receiver = new Receiver(opts.plugin, opts.secret)
  receiver.registerPaymentHandler(opts.paymentHandler)
  await receiver.connect()
  return receiver
}

export class Receiver {
  protected plugin: PluginV2
  protected secret: Buffer
  protected receiverId: string
  protected paymentHandler: PaymentHandler
  protected address: string
  protected payments: Object
  protected connected: boolean

  constructor (plugin: PluginV2 | PluginV1, secret: Buffer) {
    this.plugin = convertToV2Plugin(plugin)
    assert(secret.length >= 32, 'secret must be at least 32 bytes')
    this.secret = secret
    // TODO is the receiver ID necessary if ILDCP will return different addresses for each listener?
    this.receiverId = getReceiverId(this.secret)
    this.paymentHandler = this.defaultPaymentHandler
    this.address = ''
    this.payments = {}
    this.connected = false
  }

  async connect (): Promise<void> {
    debug('connect called')
    await this.plugin.connect()
    // TODO refetch address if we're connected for long enough
    this.address = (await ILDCP.fetch(this.plugin.sendData.bind(this.plugin))).clientAddress
    this.plugin.registerDataHandler(this.handleData)
    this.connected = true
    debug('connected')
  }

  async disconnect (): Promise<void> {
    debug('disconnect called')
    this.connected = false
    this.plugin.deregisterDataHandler()
    await this.plugin.disconnect()
    debug('disconnected')
  }

  isConnected (): boolean {
    this.connected = this.connected && this.plugin.isConnected()
    return this.connected
  }

  registerPaymentHandler (handler: PaymentHandler): void {
    debug('registered payment handler')
    assert(typeof handler === 'function', 'payment handler must be a function')
    this.paymentHandler = handler
  }

  deregisterPaymentHandler (): void {
    this.paymentHandler = this.defaultPaymentHandler
  }

  generateAddressAndSecret (): { destinationAccount: string, sharedSecret: Buffer } {
    assert(this.connected, 'Receiver must be connected')
    const token = crypto.randomBytes(TOKEN_LENGTH)
    return {
      sharedSecret: generateSharedSecret(this.secret, token),
      destinationAccount: `${this.address}.${this.receiverId}.${base64url(token)}`
    }
  }

  protected async defaultPaymentHandler (params: PaymentHandlerParams): Promise<void> {
    debug(`Receiver has no handler registered, rejecting payment ${params.paymentId}`)
    return params.reject('Receiver has no payment handler registered')
  }

  protected reject (code: string, message?: string, data?: Buffer) {
    return IlpPacket.serializeIlpReject({
      code,
      message: message || '',
      data: data || Buffer.alloc(0),
      triggeredBy: this.address
    })
  }

  // This is an arrow function so we don't need to use bind when setting it on the plugin
  protected handleData = async (data: Buffer): Promise<Buffer> => {
    let prepare: IlpPacket.IlpPrepare
    let sharedSecret: Buffer

    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
      const parsedAccount = parseAccount(prepare.destination)

      assert(parsedAccount.receiverId === this.receiverId, 'payment is for a different receiver')

      sharedSecret = generateSharedSecret(this.secret, parsedAccount.token)
    } catch (err) {
      debug('error parsing incoming prepare:', err)
      return this.reject('F06', 'Payment is not for this receiver')
    }

    let request: PskPacket
    try {
      request = deserializePskPacket(sharedSecret, prepare.data)
    } catch (err) {
      debug('error decrypting data:', err)
      return this.reject('F06', 'Unable to decrypt data')
    }

    if (request.type !== constants.TYPE_CHUNK && request.type !== constants.TYPE_LAST_CHUNK) {
      debug(`got unexpected request type: ${request.type}`)
      return this.reject('F06', 'Unexpected request type')
    }

    const paymentId = request.paymentId.toString('hex')
    let record = this.payments[paymentId]
    if (!record) {
      record = {
        // TODO buffer user data and keep track of sequence numbers
        received: new BigNumber(0),
        expected: new BigNumber(0),
        finished: false,
        finishedPromise: null,
        acceptedByReceiver: null,
        rejectionMessage: 'rejected by receiver',
        chunksFulfilled: 0,
        chunksRejected: 0 // doesn't include chunks we cannot parse
      }
      this.payments[paymentId] = record
    }
    record.expected = request.paymentAmount

    function rejectTransfer (message: string) {
      debug(`rejecting transfer ${request.sequence} of payment ${paymentId}: ${message}`)
      record.chunksRejected += 1
      const data = serializePskPacket(sharedSecret, {
        type: constants.TYPE_ERROR,
        paymentId: request.paymentId,
        sequence: request.sequence,
        paymentAmount: record.received,
        chunkAmount: new BigNumber(prepare.amount)
      })
      return this.reject('F99', '', data)
    }

    // Transfer amount too low
    if (request.chunkAmount.gt(prepare.amount)) {
      return rejectTransfer(`incoming transfer amount too low. actual: ${prepare.amount}, expected: ${request.chunkAmount.toString(10)}`)
    }

    // Already received enough
    if (record.received.gte(record.expected)) {
      return rejectTransfer(`already received enough for payment. received: ${record.received.toString(10)}, expected: ${record.expected.toString(10)}`)
    }

    // TODO should we reject an incoming chunk if it would put us too far over the expected amount?

    // Check if the receiver wants to accept the payment
    if (record.acceptedByReceiver === null) {
      try {
        await new Promise(async (resolve, reject) => {
          await this.paymentHandler({
            // TODO include first chunk data
            paymentId,
            expectedAmount: record.expected.toString(10),
            accept: async (): Promise<PaymentReceived> => {
              resolve()
              // The promise returned to the receiver will be fulfilled
              // when the whole payment is finished
              const payment = await new Promise((resolve, reject) => {
                record.finishedPromise = { resolve, reject }
                // TODO should the payment timeout after some time?
              }) as PaymentReceived

              return payment
            },
            reject: (message: string) => {
              debug('receiver rejected payment with message:', message)
              record.acceptedByReceiver = false
              record.rejectionMessage = message
              resolve()
            }
          })

          // If the user didn't call the accept function, reject it
          reject('receiver did not accept payment')
        })
      } catch (err) {
        record.acceptedByReceiver = false
        record.rejectionMessage = err && err.message
      }
    }

    // Reject the chunk if the receiver didn't want the payment
    if (record.acceptedByReceiver === false) {
      debug(`rejecting chunk because payment ${paymentId} was rejected by receiver with message: ${record.rejectionMessage}`)
      record.chunksRejected += 1
      return this.reject('F99', record.rejectionMessage)
    }

    // Check if we can regenerate the correct fulfillment
    let fulfillment
    try {
      fulfillment = dataToFulfillment(sharedSecret, prepare.data)
      const generatedCondition = fulfillmentToCondition(fulfillment)
      assert(generatedCondition.equals(prepare.executionCondition), `condition generated does not match. expected: ${prepare.executionCondition.toString('base64')}, actual: ${generatedCondition.toString('base64')}`)
    } catch (err) {
      debug('error regenerating fulfillment:', err)
      record.chunksRejected += 1
      return this.reject('F05', 'condition generated does not match prepare')
    }

    record.chunksFulfilled += 1
    debug(`got ${record.finished ? 'last ' : ''}chunk of amount ${prepare.amount} for payment: ${paymentId}. total received: ${record.received.toString(10)}`)

    // Update stats based on that chunk
    record.received = record.received.plus(prepare.amount)
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
      chunkAmount: new BigNumber(prepare.amount)
    })

    debug(`fulfilling transfer ${request.sequence} for payment ${paymentId} with fulfillment: ${fulfillment.toString('base64')}`)

    return IlpPacket.serializeIlpFulfill({
      fulfillment,
      data: response
    })
  }
}

function parseAccount (destinationAccount: string): { destinationAccount: string, receiverId: string, token: Buffer } {
  const split = destinationAccount.split('.')
  assert(split.length >= 2, 'account must have receiverId and token components')
  const receiverId = split[split.length - 2]
  const token = Buffer.from(split[split.length - 1], 'base64')
  return {
    destinationAccount: split.slice(0, split.length - 2).join('.'),
    receiverId,
    token
  }
}

function getReceiverId (secret: Buffer): string {
  const buf = hmac(secret, Buffer.from(RECEIVER_ID_STRING, 'utf8')).slice(0, RECEIVER_ID_LENGTH)
  return base64url(buf)
}

function generateSharedSecret (secret: Buffer, token: Buffer): Buffer {
  const sharedSecretGenerator = hmac(secret, Buffer.from(PSK_GENERATION_STRING, 'utf8'))
  return hmac(sharedSecretGenerator, token).slice(0, SHARED_SECRET_LENGTH)
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
