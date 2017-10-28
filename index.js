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

async function sendByDestinationAmount (plugin, {
  timeout,
  connector
}, {
  destinationAccount,
  destinationAmount,
  maxSourceAmount,
  sharedSecret,
  paymentId
}) {
  const result = await _sendPayment(plugin, {
    timeout,
    connector
  }, {
    destinationAccount,
    destinationAmount,
    sourceAmount: maxSourceAmount,
    sharedSecret,
    id: paymentId
  })
  return result
}

async function sendBySourceAmount (plugin, {
  timeout,
  connector
}, {
  destinationAccount,
  sourceAmount,
  sharedSecret,
  paymentId
}) {
  const result = await _sendPayment(plugin, {
    timeout,
    connector
  }, {
    destinationAccount,
    sourceAmount,
    sharedSecret,
    id: paymentId
  })
  return result
}

// Send a specific source amount or deliver a destination amount.
// If both sourceAmount and destinationAmount are specified, it
// will try to deliver the destinationAmount without going over the sourceAmount
async function _sendPayment (plugin, {
  connector
}, {
  destinationAccount,
  destinationAmount,
  sourceAmount,
  sharedSecret,
  id
}) {
  // TODO send data along with payment?
  // TODO add option to fail instead of chunking payment
  // TODO add cache for destinations and max payment sizes

  const paymentId = id || uuid()
  debug(`sending new payment ${paymentId} to ${destinationAccount}. destinationAmount: ${destinationAmount}, sourceAmount: ${sourceAmount}`)

  // TODO make refund account suffix indistinguishable from receiver address
  const refundAccount = plugin.getAccount() + '.' + crypto.randomBytes(24).toString('base64')
  debug(`generated refund account: ${refundAccount}`)

  // TODO (more complicated) send through multiple connectors if there are multiple
  const firstConnector = connector || (plugin.getInfo().connectors && plugin.getInfo().connectors[0])

  // TODO should the per-transfer timeout be configurable?
  const transferTimeout = DEFAULT_TRANSFER_TIMEOUT * 1000

  // TODO if sourceAmount and destinationAmount are set, do an informational quote
  // first to see if we're likely to be able to complete the payment

  let amountSent = new BigNumber(0)
  let amountDelivered = new BigNumber(0)
  let numChunks = 0
  const startTime = Date.now()

  async function sendChunksAdjustingAmount () {
    // Start sending chunks using a default amount, then adjust it upwards or downwards
    let transferAmount = new BigNumber(DEFAULT_TRANSFER_START_AMOUNT)
    let maximumTransferAmount

    // Keep sending payments until we've reached the desired destination amount
    while (true) {
      // TODO don't send these details on every packet, only first one
      const paymentDetails = {
        method: 'pay',
        paymentId,
        destinationAmount,
        lastPayment: false,
        sourceAccount: refundAccount,
        nonce: base64url(crypto.randomBytes(16))
      }

      // Figure out if we've already sent enough or if we're close to the end
      if (destinationAmount) {
        if (amountDelivered.greaterThanOrEqualTo(destinationAmount)) {
          return
        }
        // TODO should we use the overall rate or the last chunk's rate?
        const rate = amountDelivered.dividedBy(amountSent)
        const destinationAmountRemaining = new BigNumber(destinationAmount).minus(amountDelivered)
        const sourceAmountRemaining = destinationAmountRemaining.dividedBy(rate)
        if (sourceAmountRemaining.lessThanOrEqualTo(transferAmount)) {
          transferAmount = BigNumber.max(sourceAmountRemaining.round(0), 1)
          paymentDetails.lastPayment = true
        }

        if (sourceAmount && amountSent.plus(transferAmount).greaterThan(sourceAmount)) {
          debug(`sending another chunk for payment ${paymentId} would exceed source amount limit`)
          return listenForRefund()
        }
      } else {
        if (amountSent.greaterThanOrEqualTo(sourceAmount)) {
          return
        }
        const sourceAmountRemaining = new BigNumber(sourceAmount).minus(amountSent)
        if (sourceAmountRemaining.lessThanOrEqualTo(transferAmount)) {
          transferAmount = BigNumber.max(sourceAmountRemaining.round(0), 1)
          paymentDetails.lastPayment = true
        }
      }

      // TODO encrypt packet data
      const packetData = Buffer.from(JSON.stringify(paymentDetails), 'utf8')
      const packet = IlpPacket.serializeIlpPayment({
        account: destinationAccount,
        amount: '0',
        data: packetData
      })
      const transfer = {
        id: uuid(),
        from: plugin.getAccount(),
        to: firstConnector,
        ledger: plugin.getInfo().prefix,
        amount: transferAmount.toString(10),
        ilp: base64url(packet),
        executionCondition: cryptoHelper.packetToCondition(sharedSecret, packet),
        expiresAt: new Date(Date.now() + transferTimeout).toISOString()
      }

      debug(`sending transfer for payment ${paymentId}:`, transfer)

      const transferResultPromise = _waitForTransferResult(plugin, transfer.id)
      await plugin.sendTransfer(transfer)
      const result = await transferResultPromise
      // TODO response data should be encrypted
      debug('got chunk result', result)

      // Adjust transfer amount up or down based on whether it succeeded or failed
      if (result.fulfillment) {
        // sending succeeded
        amountDelivered = BigNumber.max(result.ilp, amountDelivered)
        amountSent = amountSent.plus(transfer.amount)
        numChunks++

        debug(`sent chunk for payment ${paymentId}. amount sent: ${amountSent.toString(10) + (sourceAmount ? ' (of ' + sourceAmount + ')' : '')}, amount delivered: ${amountDelivered.toString(10) + (destinationAmount ? ' (of ' + destinationAmount + ')' : '')} (rate: ${amountDelivered.dividedBy(amountSent).toString(10)})`)

        // Increase the transfer amount as long as it doesn't go over the path's Maximum Payment Size
        const potentialTransferAmount = transferAmount.times(PAYMENT_SIZE_INCREASE_FACTOR).truncated()
        if (!maximumTransferAmount || potentialTransferAmount.lessThanOrEqualTo(maximumTransferAmount)) {
          debug(`increasing transfer amount by default factor`)
          transferAmount = potentialTransferAmount
        }
      } else {
        // sending failed
        // TODO handle if we don't get an error back
        const ilpError = IlpPacket.deserializeIlpError(Buffer.from(result.ilp || '', 'base64'))
        debug('sending chunk failed, got error:', ilpError)

        // TODO handle other types of errors (no liquidity, can't find receiver, payment already finished, etc)
        // TODO don't retry sending forever
        switch (ilpError.code) {
          case 'F08': // Payment Too Large
            // TODO handle if the error data doesn't contain the amount values
            const dataReader = oer.Reader.from(Buffer.from(ilpError.data, 'ascii'))
            const amountArrived = Long.fromBits.apply(null, dataReader.readUInt64().concat([true])).toString()
            const amountLimit = Long.fromBits.apply(null, dataReader.readUInt64().concat([true])).toString()
            let decreaseFactor = new BigNumber(amountLimit).dividedBy(amountArrived)
            if (decreaseFactor.greaterThanOrEqualTo(1)) {
              // something is wrong with the error values we got, use the default
              decreaseFactor = PAYMENT_SIZE_DECREASE_FACTOR
            }
            debug(`decreasing transfer amount by factor of: ${decreaseFactor.toString(10)}`)

            // the true path MPS might be lower than this but it definitely won't be higher
            // so this might get adjusted down more if we get more payment errors
            maximumTransferAmount = BigNumber.max(transferAmount.times(decreaseFactor).truncated(), 1)
            transferAmount = maximumTransferAmount
            break
          case 'T04': // Insufficient Liquidity
            // TODO switch to a different path if we can
            // TODO should we wait a bit and try again or fail immediately?
            debug('path has insufficient liquidity')
            return listenForRefund()

            break
          default:
            // TODO is this the right default behavior? should we keep trying?
            debug('decreasing transfer amount by default factor')
            transferAmount = BigNumber.max(transferAmount.times(PAYMENT_SIZE_DECREASE_FACTOR).truncated(), 1)
            break
        }
      }
    }
  }

  async function listenForRefund () {
    debug(`waiting for refund for payment ${paymentId}`)

    let amountReturned = 0
    try {
      amountReturned = await listenForPayment(plugin, {
        sharedSecret,
        paymentId,
        // TODO how long should we wait for the refund?
        timeout: 10,
        destinationAccount: refundAccount,
        disableRefund: true
      })
      debug(`got refund for payment ${paymentId} of ${amountReturned}`)
    } catch (err) {
      debug(`error waiting for refund for payment ${paymentId}:`, err)
    }
    throw new Error(`Sending payment ${paymentId} failed. Amount not returned: ${amountSent.minus(amountReturned || 0).toString(10)}`)
  }

  await sendChunksAdjustingAmount()

  debug(`sent payment ${paymentId}. delivered ${amountDelivered.toString(10)} to ${destinationAccount} with ${numChunks} chunks in ${Date.now() - startTime}ms`)
  return {
    sourceAmount: amountSent.toString(10),
    destinationAmount: amountDelivered.toString(10)
  }
}

// TODO don't set up and tear down listeners for every transfer
async function _waitForTransferResult (plugin, targetTransferId) {
  return new Promise((resolve, reject) => {
    function fulfillListener (transfer, fulfillment, ilp) {
      if (transfer.id === targetTransferId) {
        cleanup()
        resolve({
          fulfillment,
          ilp
        })
      }
    }

    function rejectListener (transfer, ilp) {
      if (transfer.id === targetTransferId) {
        cleanup()
        // TODO handle specific errors
        resolve({
          ilp
        })
      }
    }

    function cancelListener (transfer, cancellationReason) {
      if (transfer.id === targetTransferId) {
        cleanup()
        // TODO handle specific errors
        reject(new Error('transfer cancelled'))
      }
    }
    function cleanup () {
      plugin.removeListener('outgoing_fulfill', fulfillListener)
      plugin.removeListener('outgoing_reject', rejectListener)
      plugin.removeListener('outgoing_cancel', cancelListener)
    }
    plugin.on('outgoing_fulfill', fulfillListener)
    plugin.on('outgoing_reject', rejectListener)
    plugin.on('outgoing_cancel', cancelListener)
  })
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
      result = await sendBySourceAmount(this.plugin, {
      }, {
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
exports.sendByDestinationAmount = sendByDestinationAmount
exports.sendBySourceAmount = sendBySourceAmount
