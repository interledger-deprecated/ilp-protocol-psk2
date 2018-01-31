import BigNumber from 'bignumber.js'
import { PluginV2 } from 'ilp-compat-plugin'
import { EventEmitter2 } from 'eventemitter2'
import * as crypto from 'crypto'
import * as IlpPacket from 'ilp-packet'
import * as Debug from 'debug'
import * as Ildcp from 'ilp-protocol-ildcp'
import { Reader, Writer } from 'oer-utils'
import { Duplex } from 'stream'
import * as Long from 'long'
import * as assert from 'assert'
const debug = Debug('ilp-psk2:socket')

const TOKEN_LENGTH = 18
const DEFAULT_CHUNK_AMOUNT = new BigNumber(1000)
const PSK_FULFILLMENT_STRING = 'ilp_psk2_fulfillment'
const PSK_ENCRYPTION_STRING = 'ilp_psk2_encryption'
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export type Amount = BigNumber | string | number

export interface SendSocketOpts {
  plugin: PluginV2,
  destinationAccount: string,
  sharedSecret: Buffer
}

interface SendChunkResult {
  fulfilled: boolean,
  amountSent: BigNumber,
  amountDelivered: BigNumber,
  amountExpected: BigNumber
}

export class SendSocket extends EventEmitter2 {
  protected plugin: PluginV2
  protected sharedSecret: Buffer
  protected destinationAccount: string
  protected sendLimit: BigNumber
  protected amountSent: BigNumber
  protected amountDelivered: BigNumber
  protected connected: boolean
  protected chunkAmount: BigNumber
  protected sequence: number

  constructor (opts: SendSocketOpts) {
    super()
    this.plugin = opts.plugin
    this.sharedSecret = opts.sharedSecret
    this.destinationAccount = opts.destinationAccount
    this.connected = false
    this.chunkAmount = DEFAULT_CHUNK_AMOUNT
    this.sendLimit = new BigNumber(0)
    this.amountSent = new BigNumber(0)
    this.amountDelivered = new BigNumber(0)
    this.sequence = 0
  }

  async connect (): Promise<void> {
    await this.plugin.connect()
    this.connected = true
    this.emit('connect')
    debug('connected')
  }

  setLimit (amount: Amount): void {
    this.sendLimit = BigNumber.max(amount, this.sendLimit)
    debug(`set limit to: ${this.sendLimit}`)
    this.maybeSend()
  }

  async getRate (): Promise<BigNumber> {
    if (this.amountDelivered.greaterThan(0)) {
      return this.amountDelivered.div(this.amountSent)
    } else {
      // send test payment to determine rate
      const sourceAmount = this.chunkAmount
      const { amountDelivered } = await this.sendChunk(sourceAmount, true)
      const rate = amountDelivered.dividedBy(sourceAmount)
      return rate
    }
  }

  async sendSourceAmount (amount: Amount): Promise<void> {
    const amountToWaitFor = this.sendLimit.plus(amount)
    this.setLimit(amountToWaitFor)
    await new Promise((resolve, reject) => {
      const chunkListener = () => {
        if (this.amountSent.greaterThanOrEqualTo(amountToWaitFor)) {
          this.removeListener('money_chunk', chunkListener)
          resolve()
        }
      }
      this.on('money_chunk', chunkListener)
    })
  }

  async end (): Promise<void> {
    // TODO send message to receiver telling them not to expect any more
    this.connected = false
    this.emit('close')
    // TODO should we emit end after the receiver has confirmed?
    this.emit('end')
  }

  protected async maybeSend (): Promise<void> {
    if (!this.connected) {
      debug('not sending because socket is not connected')
      return
    }

    // TODO handle back-pressure
    const amountLeftToSend = this.sendLimit.minus(this.amountSent)
    if (amountLeftToSend.lessThanOrEqualTo(0)) {
      debug('sent desired source amount, waiting until limit is raised before sending more')
      return
    }

    const amountToSend = BigNumber.min(this.chunkAmount, amountLeftToSend)
    debug(`sending ${amountToSend} (chunk amount was: ${this.chunkAmount}, amount left before sending limit is reached: ${amountLeftToSend})`)
    const { fulfilled, amountDelivered, amountExpected } = await this.sendChunk(amountToSend)

    if (fulfilled) {
      this.amountDelivered = this.amountDelivered.plus(amountDelivered)
      this.amountSent = this.amountSent.plus(amountToSend)
      debug(`sent chunk of: ${amountToSend}, delivered: ${amountDelivered}. total sent: ${this.amountSent}, total delivered: ${this.amountDelivered}`)
      this.sequence += 1
      this.emit('money_chunk', amountToSend.toString(10))
    } else {
      // TODO the receiver should say when they've accepted the last branch
      debug(`chunk was rejected. amount delivered: ${amountDelivered}, receiver wants: ${amountExpected}`)
      if (amountExpected.equals(0)) {
        // TODO exponential backoff
        debug('reached receiver limit, waiting before sending more')
        await new Promise((resolve, reject) => setTimeout(resolve, 200))
      } else {
        // TODO should this be adjusted based on the exchange rate?
        const newChunkAmount = this.chunkAmount
          .times(amountExpected.dividedBy(amountDelivered))
          .round(0, BigNumber.ROUND_CEIL)
        debug(`adjusting chunk size from ${this.chunkAmount} to ${newChunkAmount}`)
        this.chunkAmount = newChunkAmount
      }
    }

    this.chunkAmount = BigNumber.min(10, this.chunkAmount)

    // TODO handle backpressure from the receiver

    return this.maybeSend()
  }

  // TODO return how much more the receiver wants?
  private async sendChunk (amount: BigNumber, unfulfillable = false): Promise<SendChunkResult> {
    debug(`sending${unfulfillable ? ' unfulfillable' : ''} chunk for: ${amount.toString(10)}`)

    const sequence = this.sequence
    const pskRequest: ChunkRequest = {
      type: Type.Chunk,
      sequence,
      // TODO set minimum amount based on the rate
      minimumAmount: new BigNumber(0)
    }
    const pskData = serializePacket(this.sharedSecret, pskRequest)
    let fulfillment
    let executionCondition
    if (unfulfillable) {
      executionCondition = Buffer.alloc(32, 0)
    } else {
      fulfillment = dataToFulfillment(this.sharedSecret, pskData)
      executionCondition = fulfillmentToCondition(fulfillment)
    }
    const prepare = IlpPacket.serializeIlpPrepare({
      destination: this.destinationAccount,
      amount: amount.toString(10),
      expiresAt: new Date(Date.now() + 30000),
      executionCondition,
      data: pskData
    })

    const response = IlpPacket.deserializeIlpPacket(await this.plugin.sendData(prepare))
    let responsePacket: IlpPacket.IlpFulfill | IlpPacket.IlpRejection
    if (response.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      responsePacket = response.data as IlpPacket.IlpFulfill
    } else if (response.type === IlpPacket.Type.TYPE_ILP_REJECT) {
      responsePacket = response.data as IlpPacket.IlpRejection
    } else {
      throw new Error(`unexpected ILP packet type: ${response.type} (${response.typeString})`)
    }

    let pskResponse: ChunkFulfill | ChunkReject
    try {
      // TODO clean this up
      const parsed = deserializePacket(this.sharedSecret, responsePacket.data)
      assert(parsed.sequence === sequence, 'wrong sequence: ' + sequence)
      if (isResponse(parsed)) {
        pskResponse = parsed
      } else {
        throw new Error('packet is not a response')
      }
      if (pskResponse.type === Type.Fulfill) {
        assert(response.type === IlpPacket.Type.TYPE_ILP_FULFILL, 'psk response type does not match ILP packet type')
      }
      if (pskResponse.type === Type.Reject) {
        assert(response.type === IlpPacket.Type.TYPE_ILP_REJECT, 'psk response type does not match ILP packet type')
      }
    } catch (err) {
      // TODO handle this error
      throw err
    }

    return {
      fulfilled: response.type === IlpPacket.Type.TYPE_ILP_FULFILL,
      amountSent: amount,
      // TODO rename these fields because they sound like the absolute ones
      amountDelivered: pskResponse.amountReceived,
      amountExpected: pskResponse.additionalExpected
    }
  }
}

export async function createSocket (opts: SendSocketOpts) {
  const socket = new SendSocket(opts)
  await socket.connect()
  return socket
}

export interface ReceiveSocketOpts {
  destinationAccount: string,
  sharedSecret: Buffer
}

export class ReceiveSocket extends EventEmitter2 {
  public readonly destinationAccount: string
  public readonly sharedSecret: Buffer
  protected amountReceived: BigNumber
  protected receiveLimit: BigNumber
  protected closed: boolean
  // TODO should you be able to access these values?

  constructor (opts: ReceiveSocketOpts) {
    super()

    this.destinationAccount = opts.destinationAccount
    this.sharedSecret = opts.sharedSecret
    this.amountReceived = new BigNumber(0)
    this.receiveLimit = new BigNumber(0)
    this.closed = false
  }

  setLimit (amount: Amount): void {
    this.receiveLimit = new BigNumber(amount)
  }

  async receiveAmount (amount: Amount): Promise<void> {
    const amountToWaitFor = this.receiveLimit.plus(amount)
    this.receiveLimit = amountToWaitFor
    await new Promise((resolve, reject) => {
      const chunkListener = () => {
        if (this.amountReceived.greaterThanOrEqualTo(amountToWaitFor)) {
          this.removeListener('money_chunk', chunkListener)
          resolve()
        }
      }
      this.on('money_chunk', chunkListener)
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
    if (this.closed) {
      // TODO return PSK error saying socket is closed
      debug('rejecting incoming prepare because socket is closed')
      return IlpPacket.serializeIlpReject({
        code: 'F99',
        triggeredBy: this.destinationAccount,
        message: 'socket is closed',
        data: Buffer.alloc(0)
      })
    }

    let pskRequest: ChunkRequest | ChunkLastRequest
    try {
      const parsed = deserializePacket(this.sharedSecret, prepare.data)
      if (parsed.type === Type.Chunk) {
        pskRequest = parsed
      } else if (parsed.type === Type.LastChunk) {
        pskRequest = parsed
      } else {
        throw new Error('unexpected PSK packet type: ' + parsed.type)
      }
    } catch (err) {
      // TODO handle this error
      debug('got invalid psk packet:', err)
      throw err
    }

    debug(`received prepare for: ${prepare.amount}, amount received previously: ${this.amountReceived}, receive limit: ${this.receiveLimit}`)

    // TODO check prepare amount is at least what's specified in the psk packet
    const maxAmountToAccept = this.receiveLimit
      .times(1.01).round(0, BigNumber.ROUND_CEIL)
      .minus(this.amountReceived)
    if (maxAmountToAccept.lessThan(prepare.amount)) {
      debug(`rejecting prepare because it exceeds the max amount we will accept: ${maxAmountToAccept}`)
      // TODO reject saying we've got too much right now
      const pskReject = serializePacket(this.sharedSecret, {
        type: Type.Reject,
        sequence: pskRequest.sequence,
        amountReceived: new BigNumber(prepare.amount),
        additionalExpected: new BigNumber(0)
      })
      return IlpPacket.serializeIlpReject({
        code: 'T00',
        triggeredBy: this.destinationAccount,
        message: 'exceeded receive limit',
        data: pskReject
      })
    }

    // fulfill
    this.amountReceived = this.amountReceived.plus(prepare.amount)
    this.emit('money_chunk', prepare.amount)
    // TODO generate real fulfillment
    const additionalExpected = BigNumber.max(0, this.receiveLimit.minus(this.amountReceived))
    const fulfillment = dataToFulfillment(this.sharedSecret, prepare.data)
    const pskResponse = serializePacket(this.sharedSecret, {
      type: Type.Fulfill,
      sequence: pskRequest.sequence,
      amountReceived: new BigNumber(prepare.amount),
      additionalExpected
    })
    debug(`fulfilling packet, telling sender we want ${additionalExpected}`)
    return IlpPacket.serializeIlpFulfill({
      fulfillment,
      data: pskResponse
    })
  }
}

export interface ReceiverOpts {
  plugin: PluginV2,
  receiverSecret?: Buffer
}

export class Receiver {
  protected receiverSecret: Buffer
  protected plugin: PluginV2
  protected sockets: Map<string, ReceiveSocket>
  protected account: string
  protected connected: boolean

  constructor (opts: ReceiverOpts) {
    this.receiverSecret = opts.receiverSecret || crypto.randomBytes(32)
    this.plugin = opts.plugin
    this.sockets = new Map()
    this.account = ''
    this.connected = false
  }

  async connect (): Promise<void> {
    this.plugin.registerDataHandler(this.handleData.bind(this))
    await this.plugin.connect()
    const config = await Ildcp.fetch(this.plugin.sendData.bind(this.plugin))
    // TODO get ILDCP config
    this.account = config.clientAddress
    this.connected = true
  }

  async disconnect (): Promise<void> {
    this.plugin.deregisterDataHandler()
    await this.plugin.disconnect()
    for (let [_, socket] of this.sockets) {
      await socket.close()
    }
    this.connected = false
    debug('disconnected')
  }

  createSocket (token?: Buffer): ReceiveSocket {
    if (!this.connected) {
      throw new Error('receiver is not connected')
    }
    if (!token) {
      token = crypto.randomBytes(TOKEN_LENGTH)
    }
    const token64 = base64url(token)
    const destinationAccount = this.account + '.' + token64
    const sharedSecret = this.generateSharedSecret(token)
    if (this.sockets.has(token64)) {
      return (this.sockets.get(token64) as ReceiveSocket)
    } else {
      const socket = new ReceiveSocket({
        destinationAccount,
        sharedSecret
      })
      debug('created new socket with token:', token64)
      this.sockets.set(token64, socket)
      socket.once('close', () => {
        debug('removing socket:', token64)
        this.sockets.delete(token64!)
      })
      return socket
    }
  }

  protected generateSharedSecret (token: Buffer): Buffer {
    // TODO implement this
    return Buffer.alloc(32)
  }

  protected async handleData (data: Buffer): Promise<Buffer> {
    // determine which socket it's for
    let prepare: IlpPacket.IlpPrepare
    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
    } catch (err) {
      debug('receiver got invalid packet:', data.toString('hex'))
    }

    const addressParts = prepare!.destination.split('.')
    const token = addressParts[addressParts.length - 1]

    const socket = this.sockets.get(token)
    if (socket) {
      return socket.handlePrepare(prepare!)
    } else {
      debug('no socket listening for token:', token)
      return IlpPacket.serializeIlpReject({
        code: 'F02',
        data: Buffer.alloc(0),
        triggeredBy: this.account,
        message: 'no socket'
      })
    }
  }
}

export async function createReceiver (opts: ReceiverOpts): Promise<Receiver> {
  const receiver = new Receiver(opts)
  await receiver.connect()
  return receiver
}

function base64url (buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export enum Type {
  Chunk = 1,
  LastChunk = 2,
  Fulfill = 3,
  Reject = 4
}

export interface ChunkRequest {
  type: Type.Chunk,
  sequence: number,
  minimumAmount: BigNumber
}

export interface ChunkLastRequest {
  type: Type.LastChunk,
  sequence: number,
  minimumAmount: BigNumber
}

export interface ChunkFulfill {
  type: Type.Fulfill,
  sequence: number,
  amountReceived: BigNumber,
  additionalExpected: BigNumber
}

export interface ChunkReject {
  type: Type.Reject,
  sequence: number,
  amountReceived: BigNumber,
  additionalExpected: BigNumber
}

export type Packet = ChunkRequest | ChunkLastRequest | ChunkFulfill | ChunkReject

export function serializePacket (sharedSecret: Buffer, packet: Packet): Buffer {
  const writer = new Writer()
  writer.writeUInt8(packet.type)
  writer.writeUInt32(packet.sequence)
  if (isRequest(packet)) {
    assert(packet.minimumAmount.greaterThanOrEqualTo(0), 'minimumAmount must be greater than 0')
    writer.writeUInt64(bigNumberToHighLow(packet.minimumAmount))
  } else {
    assert(packet.amountReceived.greaterThanOrEqualTo(0), 'amountReceived must be greater than 0')
    assert(packet.additionalExpected.greaterThanOrEqualTo(0), 'additionalExpected must be greater than 0')
    writer.writeUInt64(bigNumberToHighLow(packet.amountReceived))
    writer.writeUInt64(bigNumberToHighLow(packet.additionalExpected))
  }
  const plaintext = writer.getBuffer()
  return encrypt(sharedSecret, plaintext)
}

export function deserializePacket (sharedSecret: Buffer, data: Buffer): Packet {
  const plaintext = decrypt(sharedSecret, data)
  const reader = Reader.from(plaintext)
  const type = reader.readUInt8()
  switch (type) {
    case Type.Chunk:
      return {
        type,
        sequence: reader.readUInt32(),
        minimumAmount: highLowToBigNumber(reader.readUInt64())
      } as ChunkRequest
    case Type.LastChunk:
      return {
        type,
        sequence: reader.readUInt32(),
        minimumAmount: highLowToBigNumber(reader.readUInt64())
      } as ChunkLastRequest
    case Type.Fulfill:
      return {
        type,
        sequence: reader.readUInt32(),
        amountReceived: highLowToBigNumber(reader.readUInt64()),
        additionalExpected: highLowToBigNumber(reader.readUInt64())
      } as ChunkFulfill
    case Type.Reject:
      return {
        type,
        sequence: reader.readUInt32(),
        amountReceived: highLowToBigNumber(reader.readUInt64()),
        additionalExpected: highLowToBigNumber(reader.readUInt64())
      } as ChunkReject
    default:
      throw new Error('unknown packet type: ' + type)
  }

}

function isRequest (packet: Packet): packet is ChunkRequest | ChunkLastRequest {
  return packet.type === Type.Chunk || packet.type === Type.LastChunk
}

function isResponse (packet: Packet): packet is ChunkFulfill | ChunkReject {
  return packet.type === Type.Fulfill || packet.type === Type.Reject
}

function hmac (key: Buffer, message: Buffer): Buffer {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

export function dataToFulfillment (secret: Buffer, data: Buffer): Buffer {
  const key = hmac(secret, Buffer.from(PSK_FULFILLMENT_STRING, 'utf8'))
  const fulfillment = hmac(key, data)
  return fulfillment
}

export function fulfillmentToCondition (preimage: Buffer): Buffer {
  const h = crypto.createHash('sha256')
  h.update(preimage)
  return h.digest()
}

function encrypt (secret: Buffer, data: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH)
  const pskEncryptionKey = hmac(secret, Buffer.from(PSK_ENCRYPTION_STRING, 'utf8'))
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, pskEncryptionKey, iv)

  const encryptedInitial = cipher.update(data)
  const encryptedFinal = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    iv,
    tag,
    encryptedInitial,
    encryptedFinal
  ])
}

function decrypt (secret: Buffer, data: Buffer): Buffer {
  assert(data.length > 0, 'cannot decrypt empty buffer')
  const pskEncryptionKey = hmac(secret, Buffer.from(PSK_ENCRYPTION_STRING, 'utf8'))
  const nonce = data.slice(0, IV_LENGTH)
  const tag = data.slice(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = data.slice(IV_LENGTH + AUTH_TAG_LENGTH)
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, pskEncryptionKey, nonce)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])
}

// oer-utils returns [high, low], whereas Long expects low first
function highLowToBigNumber (highLow: number[]): BigNumber {
  // TODO use a more efficient method to convert this
  const long = Long.fromBits(highLow[1], highLow[0], true)
  return new BigNumber(long.toString(10))
}

function bigNumberToHighLow (bignum: BigNumber): number[] {
  const long = Long.fromString(bignum.toString(10), true)
  return [long.getHighBitsUnsigned(), long.getLowBitsUnsigned()]
}
