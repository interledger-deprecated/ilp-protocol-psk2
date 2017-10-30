const assert = require('assert')
const crypto = require('crypto')
const IlpPacket = require('ilp-packet')
const oer = require('oer-utils')
const uuid = require('uuid')
const cryptoHelper = require('./crypto')
const base64url = require('./base64url')
const BigNumber = require('bignumber.js')
const Long = require('long')
const debug = require('debug')('ilp:psk2')
const EventEmitter = require('eventemitter2')

const MAX_UINT64 = '18446744073709551615'
const NULL_CONDITION = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const DEFAULT_TRANSFER_TIMEOUT = 30
// TODO what is a reasonable transfer amount to start?
const DEFAULT_TRANSFER_START_AMOUNT = 1000
const PAYMENT_SIZE_INCREASE_FACTOR = 1.1
const PAYMENT_SIZE_DECREASE_FACTOR = 0.5

// TODO add rate cache
async function quoteBySourceAmount (plugin, {
  timeout,
  connector
}, {
  destinationAccount,
  sourceAmount,
  sharedSecret
}) {
  const firstConnector = connector || (plugin.getInfo().connectors && plugin.getInfo().connectors[0])
  const timeoutMilliseconds = (timeout || DEFAULT_TRANSFER_TIMEOUT) * 1000
  const packetData = Buffer.from(JSON.stringify({method: 'quote'}), 'utf8')
  const quoteTransfer = {
    id: uuid(),
    from: plugin.getAccount(),
    to: firstConnector,
    ledger: plugin.getInfo().prefix,
    amount: sourceAmount,
    ilp: base64url(IlpPacket.serializeIlpPayment({
      account: destinationAccount,
      amount: '0',
      data: packetData
    })),
    executionCondition: NULL_CONDITION,
    expiresAt: new Date(Date.now() + timeoutMilliseconds).toISOString()
  }
  debug('sending quote transfer:', quoteTransfer)

  const quoteTransferPromise = new Promise((resolve, reject) => {
    plugin.on('outgoing_reject', listener)
    // TODO don't add a new listener for every quote
    function listener (transfer, rejectionReason) {
      if (transfer.id === quoteTransfer.id) {
        plugin.removeListener('outgoing_reject', listener)
        resolve(rejectionReason.message)
      }
    }
    setTimeout(() => {
      reject(new Error('Quote timed out'))
    }, timeoutMilliseconds)
  })

  await plugin.sendTransfer(quoteTransfer)

  const rejectionMessage = await quoteTransferPromise

  // TODO make error messages binary
  // TODO encrypt response
  const destinationAmount = rejectionMessage
  return destinationAmount
}

async function send ({
  plugin,
  destinationAccount,
  sharedSecret,
  sourceAmount,
  connector,
  paymentId
}) {
  const payment = new OutgoingPayment({
    plugin,
    destinationAccount,
    sharedSecret,
    connector,
    id: paymentId
  })

  while (payment.amountSent.lessThan(sourceAmount)) {
    const sourceAmountLeftToSend = new BigNumber(sourceAmount).minus(payment.amountSent)
    const amount = BigNumber.min(sourceAmountLeftToSend, payment.recommendedTransferAmount)
    const result = await payment.sendChunk({ amount })

    if (!result.sent) {
      if (result.retry && result.wait) {
        await new Promise((resolve, reject) => {
          setTimeout(() => resolve(), result.wait)
        })
      } else {
        return payment.waitForRefund()
      }
    }
  }

  return {
    sourceAmount: payment.amountSent.toString(10),
    destinationAmount: payment.amountDelivered.toString(10)
  }
}

async function deliver ({
  plugin,
  destinationAccount,
  sharedSecret,
  destinationAmount,
  connector,
  paymentId
}) {
  const payment = new OutgoingPayment({
    plugin,
    destinationAccount,
    sharedSecret,
    connector,
    id: paymentId
  })

  // TODO try to hit the destination amount exactly by adjusting the chunk size before the last one
  while (payment.amountDelivered.lessThan(destinationAmount)) {
    const rate = payment.getRate()
    let amount
    if (rate.equals(0)) {
      amount = payment.recommendedTransferAmount
    } else {
      const amountLeftToDeliver = new BigNumber(destinationAmount).minus(payment.amountDelivered)
      const sourceAmountLeftToSend = BigNumber.max(amountLeftToDeliver.dividedBy(rate).round(0), 1)
      amount = BigNumber.min(sourceAmountLeftToSend, payment.recommendedTransferAmount)
    }

    const result = await payment.sendChunk({ amount })

    if (result.sent) {
      continue
    }

    if (result.retry) {
      if (result.wait) {
        await new Promise((resolve, reject) => {
          setTimeout(() => resolve(), result.wait)
        })
      } else {
        continue
      }
    } else {
      return payment.waitForRefund()
    }
  }

  return {
    sourceAmount: payment.amountSent.toString(10),
    destinationAmount: payment.amountDelivered.toString(10)
  }
}

class OutgoingPayment extends EventEmitter {
  constructor ({
    id,
    destinationAccount,
    sharedSecret,
    plugin,
    chunkTimeout,
    connector
  }) {
    super()
    this.id = id || uuid()
    this.destinationAccount = destinationAccount
    this.sharedSecret = sharedSecret
    this.plugin = plugin
    this.chunkTimeout = chunkTimeout || DEFAULT_TRANSFER_TIMEOUT * 1000
    this.firstConnector = connector || (plugin.getInfo().connectors && plugin.getInfo().connectors[0])
    // TODO make sure we have a connector to send to

    debug(`sending new payment ${this.id} to ${destinationAccount}`)

    // TODO add option to disable refund
    this.refundAccount = this.plugin.getAccount() + '.' + base64url(crypto.randomBytes(24))

    // map of transferId to boolean whether transfer succeeded or failed (null indicates unresolved)
    this.transfers = {}
    this.numChunks = 0
    this.amountSent = new BigNumber(0)
    this.amountDelivered = new BigNumber(0)
    this.maximumTransferAmount = new BigNumber(MAX_UINT64)
    // TODO should this be configurable?
    this.recommendedTransferAmount = new BigNumber(DEFAULT_TRANSFER_START_AMOUNT)

    this._fulfillListener = this._handleFulfill.bind(this)
    this._rejectListener = this._handleReject.bind(this)
    this._cancelListener = this._handleCancel.bind(this)
    this.plugin.on('outgoing_fulfill', this._fulfillListener)
    this.plugin.on('outgoing_reject', this._rejectListener)
    this.plugin.on('outgoing_cancel', this._cancelListener)

    // TODO start listening for refund
  }

  // TODO add method to discover path Maximum Payment Size

  getRate () {
    // TODO should we use a weighted average?
    if (this.amountSent.greaterThanOrEqualTo(1)) {
      return this.amountDelivered.dividedBy(this.amountSent)
    } else {
      // TODO send a test payment to determine the rate
      return new BigNumber(0)
    }
  }

  async sendChunk({ amount, headers }) {
    assert(new BigNumber(amount).greaterThanOrEqualTo(0), 'cannot send transfer of 0 or negative amount')
    // TODO what if the amount is bigger than the maximum transfer amount?

    // TODO should the headers be able to overwrite these values?
    const paymentDetails = Object.assign({}, headers, {
      method: 'pay',
      paymentId: this.id,
      // TODO add a way to indicate a minimum chunk destination amount the receiver will accept (and clarify destinationAmount is total destination amount)
      sourceAccount: this.refundAccount,
      nonce: base64url(crypto.randomBytes(16))
    })

    debug(`sending chunk for payment ${this.id} of amount: ${amount}`)

    const packetData = Buffer.from(JSON.stringify(paymentDetails), 'utf8')
    const packet = IlpPacket.serializeIlpPayment({
      account: this.destinationAccount,
      amount: '0',
      data: packetData
    })
    const transfer = {
      id: uuid(),
      from: this.plugin.getAccount(),
      to: this.firstConnector,
      ledger: this.plugin.getInfo().prefix,
      amount: new BigNumber(amount).toString(10),
      ilp: base64url(packet),
      executionCondition: cryptoHelper.packetToCondition(this.sharedSecret, packet),
      expiresAt: new Date(Date.now() + this.chunkTimeout).toISOString()
    }
    this.transfers[transfer.id] = null

    try {
      await this.plugin.sendTransfer(transfer)
    } catch (err) {
      debug(`error sending transfer for payment ${this.id}`, err)
      this.emit('chunk_error', err)
      throw err
    }

    const result = await new Promise((resolve, reject) => {
      this.once('_chunk_result_' + transfer.id, resolve)
    })

    if (result.sent) {
      debug(`sent chunk for payment ${this.id}. amount sent: ${this.amountSent.toString(10)}, amount delivered: ${this.amountDelivered.toString(10)}, rate: ${this.getRate()}`)
    } else {
      debug(`sending chunk for payment ${this.id} failed`)
    }

    return result
  }

  end () {
    _cleanupListeners()
    this.emit('end')
  }

  _cleanupListeners () {
    this.plugin.removeListener('outgoing_fulfill', this._fulfillListener)
    this.plugin.removeListener('outgoing_reject', this._rejectListener)
    this.plugin.removeListener('outgoing_cancel', this._cancelListener)
  }

  _handleFulfill (transfer, fulfillment, ilp) {
    if (this.transfers[transfer.id] !== null) {
      return
    }

    this.transfers[transfer.id] = true

    // TODO parse amountDelivered from ilp packet
    this.amountDelivered = BigNumber.max(ilp, this.amountDelivered)
    this.amountSent = this.amountSent.plus(transfer.amount)
    this.numChunks++

    // Increase the transfer size if it isn't already too large
    if (!this.maximumTransferAmount || this.recommendedTransferAmount.times(PAYMENT_SIZE_INCREASE_FACTOR).lessThanOrEqualTo(this.maximumTransferAmount)) {
      this.recommendedTransferAmount = this.recommendedTransferAmount.times(PAYMENT_SIZE_INCREASE_FACTOR).truncated()
    }

    this.emit('chunk_fulfill', transfer)
    this.emit('_chunk_result_' + transfer.id, {
      sent: true
    })
  }

  _handleReject (transfer, ilp) {
    if (this.transfers[transfer.id] !== null) {
      return
    }

    this.transfers[transfer.id] = false

    let ilpError
    try {
      ilpError = IlpPacket.deserializeIlpError(Buffer.from(ilp || '', 'base64'))
    } catch (err) {
      debug(`error deserializing ILP error for chunk of payment ${this.id}`, ilp, err)
      this.emit('chunk_error', transfer, err)
      return
    }

    const sent = false
    let retry = true
    let wait = 0

    // TODO handle other types of errors (no liquidity, can't find receiver, payment already finished, etc)
    // TODO don't retry sending forever
    switch (ilpError.code) {
      case 'F08': // Payment Too Large
        let decreaseFactor
        try {
          const dataReader = oer.Reader.from(Buffer.from(ilpError.data, 'ascii'))
          const amountArrived = Long.fromBits.apply(null, dataReader.readUInt64().concat([true])).toString()
          const amountLimit = Long.fromBits.apply(null, dataReader.readUInt64().concat([true])).toString()
          decreaseFactor = new BigNumber(amountLimit).dividedBy(amountArrived)

          // the true path MPS might be lower than this but it definitely won't be higher
          // so this might get adjusted down more if we get more payment errors
          this.maximumTransferAmount = BigNumber.min(
            this.maximumTransferAmount,
            new BigNumber(transfer.amount).times(decreaseFactor).truncated(),
            new BigNumber(transfer.amount).minus(1).truncated())
          debug(`chunk for payment ${this.id} got F08 Payment Too Large error. Path Maximum Payment Size is less than or equal to ${this.maximumTransferAmount.toString(10)}`)
        } catch (err) {
          debug(`chunk for payment ${this.id} rejected with F08 Payment Too Large Error but it did not include the additional data to determine how much we should reduce the payment by:`, ilpError.data)

          // We don't know exactly what the MPS is but we know it's definitely smaller than this transfer amount
          this.maximumTransferAmount = BigNumber.min(this.maximumTransferAmount, transfer.amount)
        }

        if (this.maximumTransferAmount.lessThanOrEqualTo(1)) {
          this.maximumTransferAmount = new BigNumber(1)
        }

        if (!decreaseFactor || decreaseFactor.greaterThanOrEqualTo(1)) {
          // something is wrong with the error values we got, use the default
          decreaseFactor = new BigNumber(PAYMENT_SIZE_DECREASE_FACTOR)
        }

        if (new BigNumber(transfer.amount).lessThanOrEqualTo(this.recommendedTransferAmount)) {
          this.recommendedTransferAmount = BigNumber.min(decreaseFactor.times(transfer.amount).truncated(), this.maximumTransferAmount)
          debug(`decreasing recommended transfer amount to ${this.recommendedTransferAmount.toString(10)}`)
        }

        this.recommendedTransferAmount = BigNumber.min(this.maximumTransferAmount, this.recommendedTransferAmount)

        if (this.recommendedTransferAmount.lessThanOrEqualTo(1)) {
          this.recommendedTransferAmount = new BigNumber(1)
        }

        break
      case 'T04': // Insufficient Liquidity
        // TODO switch to a different path if we can
        debug('path has insufficient liquidity')

        retry = false
        break
      default:
        // TODO is this the right default behavior? should we keep trying?
        // TODO count the number of errors we've gotten and stop at some point
        debug('decreasing transfer amount by default factor')
        this.recommendedTransferAmount = BigNumber.max(transferAmount.times(PAYMENT_SIZE_DECREASE_FACTOR).truncated(), 1)
        break
    }

    this.emit('chunk_reject', transfer, ilpError)
    this.emit('_chunk_result_' + transfer.id, {
      sent,
      retry,
      wait
    })
  }

  _handleCancel (transfer, rejectionReason) {
    if (this.transfers[transfer.id] !== null) {
      return
    }

    this.transfers[transfer.id] = false

    // TODO handle cancel events (timeout + others)
    debug(`chunk for payment ${this.id} was cancelled`, rejectionReason)
    this.emit('chunk_error', transfer, new Error(`${rejectionReason.code} ${rejectionReason.name}: ${rejectionReason.message}`))
    this.emit('_chunk_result_' + transfer.id, {
      sent: false,
      retry: true,
      wait: 0,
    })
  }
}

function generateParams ({
  plugin,
  destinationAccount,
  receiverSecret
}) {
  const account = destinationAccount || plugin.getAccount()
  const { token, sharedSecret, receiverId } =
    cryptoHelper.generatePskParams(Buffer.from(receiverSecret, 'base64'))

  return {
    sharedSecret,
    destinationAccount: account + '.' + receiverId + token
  }
}

class IncomingPayment extends EventEmitter {
  constructor ({ id, amountExpected, sourceAccount, plugin, sharedSecret, chunkTimeout }) {
    super()
    this.id = id
    this.amountExpected = !!amountExpected && new BigNumber(amountExpected)
    this.sourceAccount = sourceAccount
    this.plugin = plugin
    this.sharedSecret = sharedSecret
    this.chunkTimeout = chunkTimeout

    this.acceptingChunks = null
    this.amountReceived = new BigNumber(0)
    this.finished = false
    this.rejectionMessage = null
    this.chunkInactivityTimer = null
  }

  accept () {
    this.acceptingChunks = true
    this.emit('accept')

    // TODO only return a promise if the user is actually going to use it
    return new Promise((resolve, reject) => {
      this.once('finish', () => resolve(this.amountReceived.toString(10)))
      this.on('error', reject)
    })
  }

  reject (rejectionMessage) {
    this.acceptingChunks = false
    this.rejectionMessage = rejectionMessage
    this.emit('end')
  }

  // TODO add pause method?

  finish () {
    this.acceptingChunks = false
    this.rejectionMessage = 'Payment already finished'
    this.emit('finish')
    this.end()
  }

  end () {
    this.acceptingChunks = false
    if (!this.rejectionMessage) {
      this.rejectionMessage = 'Payment already ended'
    }
    this.emit('end')
  }

  async _handleIncomingTransfer (transfer, paymentData) {
    if (this.acceptingChunks === null) {
      debug(`got chunk for payment ${this.id} but the receiver hasn't accepted or rejected the payment yet`)
      this.once('accept', () => {
        if (Date.parse(transfer.expiresAt) < Date.now()) {
          debug(`chunk for payment ${this.id} expired while waiting for receiver to accept payment`)
          return
        }
        this._handleIncomingTransfer(transfer, paymentData)
      })
      return
    } else if (this.acceptingChunks === false) {
      try {
        await this.plugin.rejectIncomingTransfer(transfer.id, IlpPacket.serializeIlpError({
          code: 'F99',
          name: 'Application Error',
          data: this.rejectionReason,
          triggeredAt: new Date(),
          triggeredBy: this.plugin.getAccount(), // TODO should this be the account with receiver ID?
          forwardedBy: []
        }))
      } catch (err) {
        debug(`error rejecting incoming chunk for payment ${this.id}`, err)
      }
      return
    }

    const newPaymentAmount = this.amountReceived.plus(transfer.amount)
    const fulfillment = cryptoHelper.packetToPreimage(transfer.ilp, this.sharedSecret)
    // TODO encrypt fulfillment data
    try {
      await this.plugin.fulfillCondition(transfer.id, fulfillment, newPaymentAmount.toString(10))
      // TODO wait for the 'incoming_fulfill' event
    } catch (err) {
      // TODO should we emit an error or just ignore this and wait for the timeout?
      debug(`error submitting fulfillment for chunk of payment ${this.id}`, err)
      return
    }

    this.amountReceived = newPaymentAmount

    debug(`received chunk for payment ${this.id}; total received: ${newPaymentAmount.toString(10)}`)
    this.emit('chunk', {
      amount: transfer.amount
    })

    // Check if the payment is done
    if ((this.amountExpected && this.amountReceived.greaterThanOrEqualTo(this.amountExpected))
     || (!this.amountExpected && paymentData.lastPayment === true)) {
      this.finish()
      return
    } else if (paymentData.lastPayment === true) {
      this.emit('error', new Error('Payment was ended before we received the expected amount'))
      this.end()
      return
    }

    // chunk_timeout event is only informational
    // to stop the payment, the user must call refund() or end()
    if (this.chunkTimeout) {
      clearTimeout(this.chunkInactivityTimer)
      this.chunkInactivityTimer = setTimeout(() => {
        this.emit('chunk_timeout')
      }, this.chunkTimeout)
    }
  }

  async refund () {
    this.acceptingChunks = false
    this.rejectionMessage = 'Refund in progress'

    if (!this.sourceAccount) {
      debug(`refund for payment ${this.id} failed because it did not include a sourceAccount`)
      return
    }

    this.emit('refund_start')

    debug(`sending refund for payment ${this.id}. source amount: ${this.amountReceived.toString(10)})`)
    let result
    try {
      // TODO subtract each chunk sent from the amountReceived
      result = await send({
        plugin: this.plugin,
        destinationAccount: this.sourceAccount,
        sourceAmount: this.amountReceived,
        sharedSecret: this.sharedSecret,
        paymentId: this.id
      })
      debug(`sent refund for payment ${this.id}. result:`, result)
    } catch (err) {
      this.emit('refund_error', err)
      this.emit('error', new Error('Payment and refund both failed'))
      this.end()
      return
    }
    this.emit('refund_finish', result)
    this.emit('error', new Error('Payment failed and was refunded'))
    this.end()
  }
}

async function listenForPayment (plugin, { sharedSecret, paymentId, timeout, destinationAccount, disableRefund }) {
  debug(`listening for payment ${paymentId}`)
  const paymentPromise = new Promise((resolve, reject) => {
    const stopListening = listen(plugin, {
      sharedSecret,
      destinationAccount,
      disableRefund
    }, async (payment) => {
      if (payment.id === paymentId) {
        let amountReceived
        try {
         amountReceived = await payment.accept()
        } catch (err) {
          stopListening()
          reject(err)
          return
        }
        debug(`received ${amountReceived} for payment ${paymentId}`)
        stopListening()
        resolve(amountReceived)
      }
    })
  })

  // TODO what if we've already gotten some of the money but not all?
  let timer
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      debug(`timed out waiting for payment ${paymentId}`)
      reject(new Error('timed out waiting for payment ' + paymentId))
    }, (timeout || DEFAULT_PAYMENT_TIMEOUT) * 1000)
  })

  const result = await Promise.race([paymentPromise, timeoutPromise])
  clearTimeout(timer)
  return result
}

// TODO add option to allow partial payments
function listen (plugin, { receiverSecret, sharedSecret, destinationAccount, disableRefund }, handler) {
  const payments = {}

  async function listener (transfer) {
    debug('got incoming transfer', transfer)
    const packet = IlpPacket.deserializeIlpPayment(Buffer.from(transfer.ilp, 'base64'))

    if (destinationAccount && packet.account !== destinationAccount) {
      debug(`transfer does not concern us. destination account: ${packet.account}, our account: ${destinationAccount}`)
      return
    }

    const data = JSON.parse(Buffer.from(packet.data, 'base64').toString('utf8'))
    debug('parsed data', data)

    // TODO handle if we can't regenerate the shared secret (means the payment isn't for us)
    sharedSecret = (sharedSecret && Buffer.from(sharedSecret, 'base64')) ||
      _accountToSharedSecret({
        account: packet.account,
        pluginAccount: plugin.getAccount(),
        receiverSecret
      })

    // TODO the fact that it's a quote should probably be communicated in headers
    if (data.method === 'quote') {
      debug('got incoming quote request')
      try {
        await plugin.rejectIncomingTransfer(transfer.id, IlpPacket.serializeIlpError({
          code: 'F99',
          name: 'Application Error',
          // TODO quote response should be binary and encrypted
          data: transfer.amount,
          triggeredAt: new Date(),
          triggeredBy: plugin.getAccount(),
          forwardedBy: []
        }))
      } catch (err) {
        debug('error responding to quote request', err)
      }
      return
    } else if (data.method === 'pay') {
      debug('got incoming payment chunk')
      let payment = payments[data.paymentId]
      if (!payment) {
        payment = new IncomingPayment({
          id: data.paymentId,
          amountExpected: data.destinationAmount && new BigNumber(data.destinationAmount),
          sourceAccount: data.sourceAccount,
          sharedSecret,
          plugin,
          chunkTimeout: 1000 // TODO better default?
        })
        payments[data.paymentId] = payment

        if (!disableRefund) {
          payment.once('chunk_timeout', () => payment.refund())
        }

        handler(payment)
      }

      await payment._handleIncomingTransfer(transfer, data)
    }
  }

  // TODO should there be an option to not issue refunds?

  plugin.on('incoming_prepare', listener)

  return () => {
    plugin.removeListener('incoming_prepare', listener)
  }
}

function _accountToSharedSecret ({ account, pluginAccount, receiverSecret }) {
  const localPart = account.slice(pluginAccount.length + 1)
  const receiverId = base64url(cryptoHelper.getReceiverId(receiverSecret))
  const token = Buffer.from(localPart.slice(receiverId.length), 'base64')

  return cryptoHelper.getPskSharedSecret(receiverSecret, token)
}

exports.generateParams = generateParams
exports.listen = listen
exports.quoteBySourceAmount = quoteBySourceAmount
exports.send = send
exports.deliver = deliver
