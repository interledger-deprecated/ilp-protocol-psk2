'use strict'

import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
const debug = Debug('ilp-protocol-psk2:receiver')
import BigNumber from 'bignumber.js'
import { default as convertToV2Plugin, PluginV1, PluginV2 } from 'ilp-compat-plugin'
import IlpPacket = require('ilp-packet')
import * as constants from './constants'
import * as encoding from './encoding'
import { dataToFulfillment, fulfillmentToCondition } from './condition'
import * as ILDCP from 'ilp-protocol-ildcp'

const PSK_GENERATION_STRING = 'ilp_psk2_generation'
const TOKEN_LENGTH = 18
const SHARED_SECRET_LENGTH = 32

/**
 * Review callback that will be called every time the Receiver receives an incoming packet.
 *
 * The RequestHandler can call [`accept`]{@link RequestHandlerParams.accept} to fulfill the packet or [`reject`]{@link RequestHandlerParams.reject} to reject it.
 */
export interface RequestHandler {
  (params: RequestHandlerParams): any
}

export interface RequestHandlerParams {
  /** If a keyId was passed into [`createAddressAndSecret`]{@link Receiver.createAddressAndSecret}, it will be present here when a packet is sent to that `destinationAccount` */
  keyId?: Buffer,
  /** Amount that arrived */
  amount: BigNumber,
  /** Data sent by the sender */
  data: Buffer,
  /** Fulfill the packet, and optionally send some data back to the sender */
  accept: (responseData?: Buffer) => void,
  /** Reject the packet, and optionally send some data back to the sender */
  reject: (responseData?: Buffer) => void
}

/**
 * Review callback that will be called every time the Receiver receives an incoming payment or payment chunk.
 *
 * The payment handler can call the [`accept`]{@link PaymentHandlerParams.accept} or [`reject`]{@link PaymentHandlerParams.reject} methods to fulfill or reject the entire payment.
 */
export interface PaymentHandler {
  (params: PaymentHandlerParams): void | Promise<void>
}

/**
 * Parameters passed to the Receiver's payment handler callback.
 */
export interface PaymentHandlerParams {
  id: Buffer,
  /** Total amount that should be delivered by this payment.
   * If the sender has not specified a destination amount, this value will be the maximum UInt64 value or 18446744073709551615.
   */
  expectedAmount: string,
  /**
   * Accept the entire payment.
   * The Receiver will automatically fulfill all incoming chunks until the `expectedAmount`
   * has been delivered or the sender has indicated the payment is finished.
   *
   * The Promise returned will resolve to a [`PaymentReceived`]{@link PaymentReceived} when the payment is finished.
   */
  accept: () => Promise<PaymentReceived>,
  /**
   * Reject the entire payment (and all subsequent chunks with the same `id`).
   */
  reject: (message: string) => void,
  /**
   * Alternative to `accept` that gives the user more control over the payment chunks they wish to fulfill.
   * If this method is called, the PaymentHandler callback will be called again for subsequent chunks with the same payment `id`.
   */
  acceptSingleChunk: () => void,
  /**
   * Alternative to `reject` that gives the user more control over the payment chunks they wish to reject.
   * If this method is called, the PaymentHandler callback will be called again for subsequent chunks with the same payment `id`.
   */
  rejectSingleChunk: (message: string) => void,
  /**
   * Details about this prepared chunk; in the form of a parsed interledger packet.
   */
  prepare: IlpPacket.IlpPrepare
}

export interface PaymentReceived {
  id: Buffer,
  receivedAmount: string,
  expectedAmount: string,
  chunksFulfilled: number
}

/**
 * Params for instantiating a Receiver using the [`createReceiver`]{@link createReceiver} function.
 */
export interface ReceiverOpts {
  /** Ledger Plugin */
  plugin: PluginV2 | PluginV1,
  /** @deprecated */
  paymentHandler?: PaymentHandler,
  /** Callback for handling incoming packets */
  requestHandler?: RequestHandler,
  /** Cryptographic seed that will be used to generate shared secrets for multiple senders */
  secret?: Buffer
}

/**
 * PSK2 Receiver class that listens for and accepts incoming payments.
 *
 * The same Receiver may be used for accepting single-chunk payments, streaming payments, and chunked payments.
 *
 * It is recommended to use the [`createReceiver`]{@link createReceiver} function to instantiate Receivers.
 */
export class Receiver {
  protected plugin: PluginV2
  protected secret: Buffer
  protected requestHandler: RequestHandler
  protected paymentHandler: PaymentHandler
  protected address: string
  protected payments: Object
  protected connected: boolean
  protected usingRequestHandlerApi: boolean

  constructor (plugin: PluginV2 | PluginV1, secret: Buffer) {
    // TODO stop accepting PluginV1
    this.plugin = convertToV2Plugin(plugin)
    assert(secret.length >= 32, 'secret must be at least 32 bytes')
    this.secret = secret
    this.paymentHandler = this.defaultPaymentHandler
    this.address = ''
    this.payments = {}
    this.connected = false
    this.requestHandler = this.defaultRequestHandler
    this.usingRequestHandlerApi = false
  }

  /**
   * Fetch the receiver's ILP address using [ILDCP](https://github.com/interledgerjs/ilp-protocol-ildcp) and listen for incoming payments.
   */
  async connect (): Promise<void> {
    debug('connect called')
    await this.plugin.connect()
    // TODO refetch address if we're connected for long enough
    this.address = (await ILDCP.fetch(this.plugin.sendData.bind(this.plugin))).clientAddress
    this.plugin.registerDataHandler(this.handleData)
    this.connected = true
    debug('connected')
  }

  /**
   * Stop listening for incoming payments.
   */
  async disconnect (): Promise<void> {
    debug('disconnect called')
    this.connected = false
    this.plugin.deregisterDataHandler()
    await this.plugin.disconnect()
    debug('disconnected')
  }

  /**
   * Check if the receiver is currently listening for incoming payments.
   */
  isConnected (): boolean {
    this.connected = this.connected && this.plugin.isConnected()
    return this.connected
  }

  /**
   * Register a callback that will be called each time a packet is received.
   *
   * The user must call `accept` to make the Receiver fulfill the packet.
   */
  registerRequestHandler (handler: RequestHandler): void {
    if (this.paymentHandler !== this.defaultPaymentHandler) {
      throw new Error('PaymentHandler and RequestHandler APIs cannot be used at the same time')
    }
    debug('registered request handler')
    this.usingRequestHandlerApi = true
    this.requestHandler = handler
  }

  /**
   * Remove the handler callback.
   */
  deregisterRequestHandler (): void {
    this.requestHandler = this.defaultRequestHandler
  }

  /**
   * @deprecated. Switch to [`registerRequestHandler`]{@link Receiver.registerRequestHandler} instead
   */
  registerPaymentHandler (handler: PaymentHandler): void {
    console.warn('DeprecationWarning: registerPaymentHandler is deprecated and will be removed in the next version. Use registerRequestHandler instead')
    if (this.usingRequestHandlerApi) {
      throw new Error('PaymentHandler and RequestHandler APIs cannot be used at the same time')
    }
    debug('registered payment handler')
    /* tslint:disable-next-line:strict-type-predicates */
    assert(typeof handler === 'function', 'payment handler must be a function')
    this.paymentHandler = handler
  }

  /**
   * @deprecated. Use RequestHandlers instead
   */
  deregisterPaymentHandler (): void {
    this.paymentHandler = this.defaultPaymentHandler
  }

  /**
   * Generate a unique ILP address and shared secret to give to a sender.
   *
   * The Receiver must be connected before this method can be called.
   *
   * **Note:** A single shared secret MUST NOT be given to more than one sender.
   *
   * @param keyId Additional segment that will be appended to the destinationAccount and can be used to correlate payments. This is authenticated but **unencrypted** so the entire Interledger will be able to see this value.
   */
  generateAddressAndSecret (keyId?: Buffer): { destinationAccount: string, sharedSecret: Buffer } {
    assert(this.connected, 'Receiver must be connected')
    const token = crypto.randomBytes(TOKEN_LENGTH)
    const keygen = (keyId ? Buffer.concat([token, keyId]) : token)
    const sharedSecret = generateSharedSecret(this.secret, keygen)
    return {
      sharedSecret,
      destinationAccount: `${this.address}.${base64url(keygen)}`
    }
  }

  protected async defaultPaymentHandler (params: PaymentHandlerParams): Promise<void> {
    debug(`Receiver has no handler registered, rejecting payment ${params.id.toString('hex')}`)
    return params.reject('Receiver has no payment handler registered')
  }

  protected async defaultRequestHandler (params: RequestHandlerParams): Promise<void> {
    debug(`Receiver has no handler registered, rejecting request of amount: ${params.amount} with data: ${params.data.toString('hex')}`)
    return params.reject(Buffer.alloc(0))
  }

  protected reject (code: string, message?: string, data?: Buffer) {
    return IlpPacket.serializeIlpReject({
      code,
      message: message || '',
      data: data || Buffer.alloc(0),
      triggeredBy: this.address
    })
  }

  protected async callRequestHandler (requestId: number, amount: string, data: Buffer, keyId?: Buffer): Promise<{ fulfill: boolean, responseData: Buffer }> {
    let fulfill = false
    let finalized = false
    let responseData = Buffer.alloc(0)

    // This promise resolves when the user has either accepted or rejected the payment
    await new Promise(async (resolve, reject) => {
      // Reject the payment if:
      // a) the user explicity calls reject
      // b) if they don't call accept
      // c) if there is an error thrown in the request handler
      try {
        await Promise.resolve(this.requestHandler({
          keyId,
          amount: new BigNumber(amount),
          data,
          accept: (userResponse = Buffer.alloc(0)) => {
            if (finalized) {
              throw new Error(`Packet was already ${fulfill ? 'fulfilled' : 'rejected'}`)
            }
            finalized = true
            fulfill = true
            responseData = userResponse
            resolve()
          },
          reject: (userResponse = Buffer.alloc(0)) => {
            if (finalized) {
              throw new Error(`Packet was already ${fulfill ? 'fulfilled' : 'rejected'}`)
            }
            finalized = true
            responseData = userResponse
            debug(`user rejected packet with requestId: ${requestId}`)
            resolve()
          }
        }))
      } catch (err) {
        debug('error in requestHandler, going to reject the packet:', err)
      }
      debug('requestHandler returned without user calling accept or reject, rejecting the packet now')
      resolve()
    })

    return {
      fulfill,
      responseData
    }
  }

  // This is an arrow function so we don't need to use bind when setting it on the plugin
  protected handleData = async (data: Buffer): Promise<Buffer> => {
    let prepare: IlpPacket.IlpPrepare
    let sharedSecret: Buffer
    let keyId = undefined

    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
      const localPart = prepare.destination.replace(this.address + '.', '')
      const split = localPart.split('.')
      assert(split.length >= 1, 'destinationAccount does not have token')
      const keygen = Buffer.from(split[0], 'base64')
      if (keygen.length > TOKEN_LENGTH) {
        keyId = keygen.slice(TOKEN_LENGTH)
      }
      sharedSecret = generateSharedSecret(this.secret, keygen)
    } catch (err) {
      debug('error parsing incoming prepare:', err)
      return this.reject('F06', 'Packet is not an IlpPrepare')
    }

    let packet
    let isLegacy
    try {
      packet = encoding.deserializePskPacket(sharedSecret, prepare.data)
      isLegacy = false
    } catch (err) {
      try {
        packet = encoding.deserializeLegacyPskPacket(sharedSecret, prepare.data)
        isLegacy = true
      } catch (err) {
        debug('unable to parse PSK packet, either because it is an unrecognized type or because the data has been tampered with:', JSON.stringify(prepare), err && err.message)
        // TODO should this be a different error?
        return this.reject('F06', 'Unable to parse data')
      }
    }
    // Support the old PaymentHandler API for now
    if (this.usingRequestHandlerApi && !isLegacy) {
      if (packet.type !== encoding.Type.Request) {
        // TODO should this be a different error?
        debug('packet is not a PSK Request (should be type 4):', packet)
        return this.reject('F06', 'Unexpected packet type')
      }
      packet = packet as encoding.PskPacket

      // Check if the amount we received is enough
      // Note: this check must come before the fulfillment one in order for unfulfillable test payments to be used as quotes
      if (packet.amount.greaterThan(prepare.amount)) {
        debug(`incoming transfer amount too low. actual: ${prepare.amount}, expected: ${packet.amount}`)
        return this.reject('F99', '', encoding.serializePskPacket(sharedSecret, {
          type: encoding.Type.Error,
          requestId: packet.requestId,
          amount: new BigNumber(prepare.amount),
          data: Buffer.alloc(0)
        }))
      }

      // Check if we can regenerate the correct fulfillment
      let fulfillment
      try {
        fulfillment = dataToFulfillment(sharedSecret, prepare.data)
        const generatedCondition = fulfillmentToCondition(fulfillment)
        assert(generatedCondition.equals(prepare.executionCondition), `condition generated does not match. expected: ${prepare.executionCondition.toString('base64')}, actual: ${generatedCondition.toString('base64')}`)
      } catch (err) {
        debug('error regenerating fulfillment:', err)
        return this.reject('F05', 'Condition generated does not match prepare')
      }

      const { fulfill, responseData } = await this.callRequestHandler(packet.requestId, prepare.amount, packet.data, keyId)
      if (fulfill) {
        return IlpPacket.serializeIlpFulfill({
          fulfillment,
          data: encoding.serializePskPacket(sharedSecret, {
            type: encoding.Type.Response,
            requestId: packet.requestId,
            amount: new BigNumber(prepare.amount),
            data: responseData
          })
        })
      } else {
        return this.reject('F99', '', encoding.serializePskPacket(sharedSecret, {
          type: encoding.Type.Error,
          requestId: packet.requestId,
          amount: new BigNumber(prepare.amount),
          data: responseData
        }))
      }
    } else if (this.usingRequestHandlerApi && isLegacy) {
      // Legacy packets (will be removed soon)
      if (packet.type !== constants.TYPE_PSK2_CHUNK && packet.type !== constants.TYPE_PSK2_LAST_CHUNK) {
        debug('got packet with unrecognized PSK type: ', packet)
        // TODO should this be a different error?
        return this.reject('F06', 'Unsupported type')
      }

      packet = packet as encoding.LegacyPskPacket

      // Transfer amount too low
      if (packet.chunkAmount.gt(prepare.amount)) {
        debug(`incoming transfer amount too low. actual: ${prepare.amount}, expected: ${packet.chunkAmount.toString(10)}`)
        return this.reject('F99', '', encoding.serializeLegacyPskPacket(sharedSecret, {
          type: constants.TYPE_PSK2_REJECT,
          paymentId: packet.paymentId,
          sequence: packet.sequence,
          chunkAmount: new BigNumber(prepare.amount),
          paymentAmount: new BigNumber(0)
        }))
      }

      // Check if we can regenerate the correct fulfillment
      let fulfillment
      try {
        fulfillment = dataToFulfillment(sharedSecret, prepare.data)
        const generatedCondition = fulfillmentToCondition(fulfillment)
        assert(generatedCondition.equals(prepare.executionCondition), `condition generated does not match. expected: ${prepare.executionCondition.toString('base64')}, actual: ${generatedCondition.toString('base64')}`)
      } catch (err) {
        debug('error regenerating fulfillment:', err)
        return this.reject('F05', 'Condition generated does not match prepare')
      }

      const { fulfill } = await this.callRequestHandler(packet.sequence, prepare.amount, Buffer.alloc(0), keyId)
      if (fulfill) {
        return IlpPacket.serializeIlpFulfill({
          fulfillment,
          data: encoding.serializeLegacyPskPacket(sharedSecret, {
            type: constants.TYPE_PSK2_FULFILLMENT,
            paymentId: packet.paymentId,
            sequence: packet.sequence,
            paymentAmount: new BigNumber(0),
            chunkAmount: new BigNumber(prepare.amount),
            applicationData: Buffer.alloc(0)
          })
        })
      } else {
        return this.reject('F99', '', encoding.serializeLegacyPskPacket(sharedSecret, {
          type: constants.TYPE_PSK2_REJECT,
          paymentId: packet.paymentId,
          sequence: packet.sequence,
          paymentAmount: new BigNumber(0),
          chunkAmount: new BigNumber(prepare.amount),
          applicationData: Buffer.alloc(0)
        }))
      }
    } else {
      // Legacy PaymentHandler API (will be removed soon)
      let request: encoding.LegacyPskPacket
      try {
        request = encoding.deserializeLegacyPskPacket(sharedSecret, prepare.data)
      } catch (err) {
        debug('error decrypting data:', err)
        return this.reject('F06', 'Unable to parse data')
      }

      if ([constants.TYPE_PSK2_CHUNK, constants.TYPE_PSK2_LAST_CHUNK].indexOf(request.type) === -1) {
        debug(`got unexpected request type: ${request.type}`)
        // TODO should this be a different error code?
        // (this might be a sign that they're using a different version of the protocol)
        // TODO should this type of response be encrypted?
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

      const rejectTransfer = (message: string) => {
        debug(`rejecting transfer ${request.sequence} of payment ${paymentId}: ${message}`)
        record.chunksRejected += 1
        const data = encoding.serializeLegacyPskPacket(sharedSecret, {
          type: constants.TYPE_PSK2_REJECT,
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

      // Payment is already finished
      if (record.finished) {
        // TODO should this return an F99 or something else?
        return rejectTransfer(`payment is already finished`)
      }

      // TODO should we reject an incoming chunk if it would put us too far over the expected amount?

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

      // Check if the receiver wants to accept the payment
      let chunkAccepted = !!record.acceptedByReceiver
      let userCalledAcceptOrReject = false
      if (record.acceptedByReceiver === null) {
        // This promise resolves when the user has either accepted or rejected the payment
        await new Promise(async (resolve, reject) => {
          // Reject the payment if:
          // a) the user explicity calls reject
          // b) if they don't call accept
          // c) if there is an error thrown in the payment handler
          try {
            await Promise.resolve(this.paymentHandler({
              // TODO include first chunk data
              id: request.paymentId,
              expectedAmount: record.expected.toString(10),
              accept: async (): Promise<PaymentReceived> => {
                userCalledAcceptOrReject = true
                // Resolve the above promise so that we actually fulfill the incoming chunk
                record.acceptedByReceiver = true
                chunkAccepted = true
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
                userCalledAcceptOrReject = true
                debug('receiver rejected payment with message:', message)
                record.acceptedByReceiver = false
                record.rejectionMessage = message
                record.finished = false
                // TODO check that the message isn't too long
              },
              // TODO throw error if you've waited too long and it's expired
              acceptSingleChunk: (): void => {
                userCalledAcceptOrReject = true
                chunkAccepted = true
                record.acceptedByReceiver = null
                resolve()
              },
              rejectSingleChunk: (message: string) => {
                userCalledAcceptOrReject = true
                chunkAccepted = false
                record.acceptedByReceiver = null
                record.rejectionMessage = message
                resolve()
                // TODO check that the message isn't too long
              },
              prepare
            }))

            // If the user didn't call the accept function, reject it
            if (!userCalledAcceptOrReject) {
              record.acceptedByReceiver = false
              record.rejectionMessage = 'receiver did not accept the payment'
              record.finished = true
            }
          } catch (err) {
            debug('error thrown in payment handler:', err)
            record.acceptedByReceiver = false
            record.rejectionMessage = err && err.message
          }
          resolve()
        })
      }

      // Reject the chunk if the receiver rejected the whole payment
      if (record.acceptedByReceiver === false) {
        debug(`rejecting chunk because payment ${paymentId} was rejected by receiver with message: ${record.rejectionMessage}`)
        record.chunksRejected += 1
        return this.reject('F99', record.rejectionMessage)
      }

      // Reject the chunk of the receiver rejected the specific chunk
      if (!chunkAccepted) {
        debug(`rejecting chunk ${request.sequence} of payment ${paymentId} because it was rejected by the receiver with the message: ${record.rejectionMessage}`)
        record.chunksRejected += 1
        return this.reject('F99', record.rejectionMessage)
      }

      // Update stats based on that chunk
      record.chunksFulfilled += 1
      record.received = record.received.plus(prepare.amount)
      if (record.received.gte(record.expected) || request.type === constants.TYPE_PSK2_LAST_CHUNK) {
        record.finished = true
        record.finishedPromise && record.finishedPromise.resolve({
          id: request.paymentId,
          receivedAmount: record.received.toString(10),
          expectedAmount: record.expected.toString(10),
          chunksFulfilled: record.chunksFulfilled,
          chunksRejected: record.chunksRejected
          // TODO add data
        })
      }

      debug(`got ${record.finished ? 'last ' : ''}chunk of amount ${prepare.amount} for payment: ${paymentId}. total received: ${record.received.toString(10)}`)

      // Let the sender know how much has arrived
      const response = encoding.serializeLegacyPskPacket(sharedSecret, {
        type: constants.TYPE_PSK2_FULFILLMENT,
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
}

/**
 * Convenience function for instantiating and connecting a PSK2 [Receiver]{@link Receiver}.
 *
 * @example <caption>Creating a Receiver</caption>
 * ```typescript
 * import { createReceiver } from 'ilp-protocol-psk2'
 * const receiver = await createReceiver({
 *   plugin: myLedgerPlugin,
 *   requestHandler: async (params) => {
 *     params.accept()
 *     console.log(`Got payment for: ${params.amount}`)
 *   }
 * })
 *
 * const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()
 * // Give these two values to a sender to enable them to send payments to this Receiver
 * ```
 */
export async function createReceiver (opts: ReceiverOpts): Promise<Receiver> {
  const {
    plugin,
    paymentHandler,
    requestHandler,
    secret = crypto.randomBytes(32)
  } = opts
  const receiver = new Receiver(plugin, secret)
  if (paymentHandler) {
    receiver.registerPaymentHandler(paymentHandler)
  }
  if (requestHandler) {
    receiver.registerRequestHandler(requestHandler)
  }
  await receiver.connect()
  return receiver
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
