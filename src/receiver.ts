import * as assert from 'assert'
import * as crypto from 'crypto'
import * as Debug from 'debug'
const debug = Debug('ilp-protocol-psk2:receiver')
import BigNumber from 'bignumber.js'
import { default as convertToV2Plugin, PluginV1, PluginV2 } from 'ilp-compat-plugin'
import IlpPacket = require('ilp-packet')
import * as constants from './constants'
import { serializePskPacket, deserializePskPacket, PskPacket } from './encoding'
import { dataToFulfillment, fulfillmentToCondition } from './condition'
import * as ILDCP from 'ilp-protocol-ildcp'
import { EventEmitter2 } from 'eventemitter2'

const RECEIVER_ID_STRING = 'ilp_psk2_receiver_id'
const PSK_GENERATION_STRING = 'ilp_psk2_generation'
const RECEIVER_ID_LENGTH = 8
const TOKEN_LENGTH = 18
const SHARED_SECRET_LENGTH = 32

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

export interface ReceiveSocketOpts {
  destinationAccount: string,
  sharedSecret: Buffer
}

/**
 * Payment socket for receiving ILP payments.
 *
 * The socket will automatically fulfill incoming ILP Prepare packets. If there is a receive limit set, it will reject packets after that is reached.
 */
export class ReceiveSocket extends EventEmitter2 {
  public readonly destinationAccount: string
  public readonly sharedSecret: Buffer
  protected amountReceived: BigNumber
  protected receiveLimit?: BigNumber
  protected closed: boolean
  protected chunksFulfilled: number
  protected chunksRejected: number
  // TODO should you be able to access these values?

  constructor (opts: ReceiveSocketOpts) {
    super()

    this.destinationAccount = opts.destinationAccount
    this.sharedSecret = opts.sharedSecret
    this.amountReceived = new BigNumber(0)
    this.closed = false
    this.chunksFulfilled = 0
    this.chunksRejected = 0

    // TODO keep track of sequence numbers we've seen
  }

  /**
   * Set the limit of how much the socket will receive (by default there is no limit)
   */
  setLimit (amount: BigNumber | string | number): void {
    this.receiveLimit = new BigNumber(amount)
  }

  /**
   * Raise the receive limit by the given amount and returns a Promise that resolves when that much has been received.
   *
   * Note that this will raise the receive limit from whatever it is 
   */
  async receiveAmount (amount: BigNumber | string | number): Promise<void> {
    if (!this.receiveLimit) {
      this.receiveLimit = new BigNumber(0)
    }
    const amountToWaitFor = this.receiveLimit.plus(amount)
    this.receiveLimit = amountToWaitFor
    await new Promise((resolve, reject) => {
      const chunkListener = () => {
        if (this.amountReceived.greaterThanOrEqualTo(amountToWaitFor)) {
          this.removeListener('money_received', chunkListener)
          resolve()
        }
      }
      this.on('money_received', chunkListener)
    })
  }

  // TODO should there be an end method?
  async close (): Promise<void> {
    this.closed = true
    // TODO maybe don't emit this right away so that we have time to get another chunk from the sender and reject it
    this.emit('close')
    // TODO only emit end once we've told the sender
    this.emit('end')
    debug('socket closed')
  }

  /* @private */
  async handlePrepare (prepare: IlpPacket.IlpPrepare): Promise<Buffer> {
    debug('got incoming prepare:', JSON.stringify(prepare))
    if (this.closed) {
      debug('rejecting incoming prepare because socket is closed')
      // TODO return PSK error saying socket is closed
      return this.reject('F99', 'socket is closed', Buffer.alloc(0))
    }

    let request: PskPacket
    try {
      request = deserializePskPacket(this.sharedSecret, prepare.data)
    } catch (err) {
      debug('error decrypting data:', err, prepare.data.toString('hex'))
      return this.reject('F06', 'Unable to parse data')
    }

    if (request.type !== constants.TYPE_PSK2_CHUNK && request.type !== constants.TYPE_PSK2_LAST_CHUNK) {
      debug(`got unexpected request type: ${request.type}`)
      // TODO should this be a different error code?
      // (this might be a sign that they're using a different version of the protocol)
      // TODO should this type of response be encrypted?
      return this.reject('F06', 'Unexpected request type')
    }

    debug(`received prepare for: ${prepare.amount}, amount received previously: ${this.amountReceived}, receive limit: ${this.receiveLimit}`)

    if (request.chunkAmount.greaterThan(prepare.amount)) {
      debug(`rejecting chunk because the amount is less than the sender told us to accept. actual: ${prepare.amount}, expected: ${request.chunkAmount}`)
      return this.reject('F99', '', serializePskPacket(this.sharedSecret, {
        type: constants.TYPE_PSK2_ERROR,
        paymentId: request.paymentId,
        sequence: request.sequence,
        chunkAmount: new BigNumber(prepare.amount),
        paymentAmount: this.amountReceived
      }))
    }

    // Generate fulfillment and make sure it matches
    const fulfillment = dataToFulfillment(this.sharedSecret, prepare.data)
    const generatedCondition = fulfillmentToCondition(fulfillment)
    if (!generatedCondition.equals(prepare.executionCondition)) {
      debug(`condition generated does not match prepare. actual: ${base64url(generatedCondition)}, expected: ${base64url(prepare.executionCondition)}`)
      return this.reject('F05', 'Condition generated does not match prepare')
    }

    if (this.receiveLimit) {
      const maxAmountToAccept = this.receiveLimit
        .times(1.01).round(0, BigNumber.ROUND_CEIL)
        .minus(this.amountReceived)
      if (maxAmountToAccept.lessThan(prepare.amount)) {
        debug(`rejecting prepare because it exceeds the max amount we will accept: ${maxAmountToAccept}`)
        // TODO reject saying we've got too much right now
        return this.reject('T99', '', serializePskPacket(this.sharedSecret, {
          type: constants.TYPE_PSK2_ERROR,
          paymentId: request.paymentId,
          sequence: request.sequence,
          chunkAmount: new BigNumber(prepare.amount),
          paymentAmount: this.amountReceived
          // additionalExpected: new BigNumber(0)
        }))
      }
    }

    // Fulfill
    this.amountReceived = this.amountReceived.plus(prepare.amount)
    this.emit('money_received', prepare.amount)
    const additionalExpected = (this.receiveLimit ? BigNumber.max(0, this.receiveLimit.minus(this.amountReceived)) : constants.MAX_UINT64)
    const pskResponse = serializePskPacket(this.sharedSecret, {
      type: constants.TYPE_PSK2_FULFILLMENT,
      paymentId: request.paymentId,
      sequence: request.sequence,
      paymentAmount: this.amountReceived,
      chunkAmount: new BigNumber(prepare.amount)
      // additionalExpected
    })
    debug(`fulfilling packet, telling sender we want ${additionalExpected}`)
    this.chunksFulfilled += 1
    return IlpPacket.serializeIlpFulfill({
      fulfillment,
      data: pskResponse
    })
  }

  protected reject (code: string, message?: string, data?: Buffer) {
    this.chunksRejected += 1
    return IlpPacket.serializeIlpReject({
      code,
      message: message || '',
      data: data || Buffer.alloc(0),
      triggeredBy: this.destinationAccount
    })
  }
}

/**
 * Params for instantiating a Receiver using the [`createReceiver`]{@link createReceiver} function.
 */
export interface ReceiverOpts {
  plugin: PluginV2 | PluginV1,
  paymentHandler?: PaymentHandler,
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
  protected receiverId: string
  protected paymentHandler: PaymentHandler
  protected address: string
  protected payments: Object
  protected connected: boolean
  protected sockets: Map<string, ReceiveSocket>
  protected usingSocketApi: boolean

  constructor (plugin: PluginV2 | PluginV1, secret: Buffer) {
    this.plugin = convertToV2Plugin(plugin)
    assert(secret.length >= 32, 'secret must be at least 32 bytes')
    this.secret = secret
    // TODO remove receiverId, since the ILP address will be different for each ILDCP query
    this.receiverId = getReceiverId(this.secret)
    this.paymentHandler = this.defaultPaymentHandler
    this.address = ''
    this.payments = {}
    this.connected = false
    this.sockets = new Map()
    this.usingSocketApi = false
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
   * Register a callback that will be called every time a new payment is received.
   *
   * The user must call `accept` or `acceptSingleChunk` to make the Receiver fulfill the payment.
   */
  registerPaymentHandler (handler: PaymentHandler): void {
    if (this.usingSocketApi) {
      throw new Error('ReceiveSockets and payment handlers cannot be used at the same time')
    }
    debug('registered payment handler')
    /* tslint:disable-next-line:strict-type-predicates */
    assert(typeof handler === 'function', 'payment handler must be a function')
    this.paymentHandler = handler
  }

  /**
   * Remove the payment handler callback.
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
   */
  generateAddressAndSecret (): { destinationAccount: string, sharedSecret: Buffer } {
    assert(this.connected, 'Receiver must be connected')
    const token = crypto.randomBytes(TOKEN_LENGTH)
    return {
      sharedSecret: generateSharedSecret(this.secret, token),
      destinationAccount: `${this.address}.${this.receiverId}.${base64url(token)}`
    }
  }

  createReceiveSocket (token = crypto.randomBytes(16)): ReceiveSocket {
    if (this.paymentHandler !== this.defaultPaymentHandler) {
      throw new Error('ReceiveSockets and payment handlers cannot be used at the same time')
    }
    this.usingSocketApi = true

    if (!this.connected) {
      throw new Error('receiver is not connected')
    }
    const token64 = base64url(token)
    const destinationAccount = `${this.address}.${this.receiverId}.${token64}`
    const sharedSecret = generateSharedSecret(this.secret, token)
    let socket = this.sockets.get(token64)
    if (socket) {
      return socket
    } else {
      socket = new ReceiveSocket({
        destinationAccount,
        sharedSecret
      })
      // Defaults to very high limit, but the user can set it lower if they want
      socket.setLimit(constants.MAX_UINT64)
      debug(`created new socket with token: ${token64} and receive limit: ${constants.MAX_UINT64}`)
      this.sockets.set(token64, socket)
      socket.once('close', () => {
        debug('removing socket:', token64)
        this.sockets.delete(token64)
      })
      return socket
    }
  }

  protected async defaultPaymentHandler (params: PaymentHandlerParams): Promise<void> {
    debug(`Receiver has no handler registered, rejecting payment ${params.id.toString('hex')}`)
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
    let token: Buffer

    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
      const parsedAccount = parseAccount(prepare.destination)
      token = parsedAccount.token

      if (parsedAccount.receiverId !== this.receiverId) {
        throw new Error(`payment is for a different receiver. actual: ${parsedAccount.receiverId}, expected: ${this.receiverId}`)
      }

      sharedSecret = generateSharedSecret(this.secret, parsedAccount.token)
    } catch (err) {
      debug('error parsing incoming prepare:', err)
      return this.reject('F06', 'Payment is not for this receiver')
    }

    // Pass the packet to the ReceiveSocket if we are using those (instead of payment handlers)
    if (this.usingSocketApi) {
      const socket = this.sockets.get(base64url(token))
      if (socket) {
        debug('got incoming prepare for socket:', base64url(token))
        return socket.handlePrepare(prepare)
      } else {
        debug('no socket listening for token:', token)
        return IlpPacket.serializeIlpReject({
          code: 'F02',
          data: Buffer.alloc(0),
          triggeredBy: this.address,
          message: 'no socket'
        })
      }
    }

    let request: PskPacket
    try {
      request = deserializePskPacket(sharedSecret, prepare.data)
    } catch (err) {
      debug('error decrypting data:', err)
      return this.reject('F06', 'Unable to parse data')
    }

    if (request.type !== constants.TYPE_PSK2_CHUNK && request.type !== constants.TYPE_PSK2_LAST_CHUNK) {
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
      const data = serializePskPacket(sharedSecret, {
        type: constants.TYPE_PSK2_ERROR,
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
    const response = serializePskPacket(sharedSecret, {
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

/**
 * Convenience function for instantiating and connecting a PSK2 [Receiver]{@link Receiver}.
 *
 * @example <caption>Creating a Receiver</caption>
 * ```typescript
 * import { createReceiver } from 'ilp-protocol-psk2'
 * const receiver = await createReceiver({
 *   plugin: myLedgerPlugin,
 *   paymentHandler: async (params) => {
 *     // Accept all incoming payments
 *     const result = await params.accept()
 *     console.log('Got payment for:', result.receivedAmount)
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
    secret = crypto.randomBytes(32)
  } = opts
  const receiver = new Receiver(plugin, secret)
  if (paymentHandler) {
    receiver.registerPaymentHandler(paymentHandler)
  }
  await receiver.connect()
  return receiver
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
