const EventEmitter = require('eventemitter2')
const IlpPacket = require('ilp-packet')
const oer = require('oer-utils')
const BigNumber = require('bignumber.js')
const base64url = require('./base64url')

class Plugin extends EventEmitter {
  constructor ({ account, prefix, balance }) {
    super()
    this.transfers = {}
    this.pairedPlugin = null
    this.account = account
    this.prefix = prefix
    this.balance = new BigNumber(balance)
  }

  linkToOtherPlugin (otherPlugin) {
    this.pairedPlugin = otherPlugin
  }

  getAccount () {
    return this.account
  }

  getInfo () {
    return {
      prefix: this.prefix,
      connectors: [ this.pairedPlugin.account ]
    }
  }

  getBalance () {
    return Promise.resolve(this.balance.toString('10'))
  }

  sendTransfer (transfer) {
    this.transfers[transfer.id] = transfer
    this.balance = this.balance.minus(transfer.amount)
    setImmediate(() => {
      this.pairedPlugin.emit('incoming_prepare', transfer)
    })
  }

  fulfillCondition (transferId, fulfillment, ilp) {
    const transfer = this.pairedPlugin.transfers[transferId]
    setImmediate(() => {
      this.balance = this.balance.plus(transfer.amount)
      this.pairedPlugin.emit('outgoing_fulfill', transfer, fulfillment, ilp)
    })
  }

  rejectIncomingTransfer (transferId, rejectionReason) {
    const transfer = this.pairedPlugin.transfers[transferId]
    setImmediate(() => {
      this.pairedPlugin.balance = this.pairedPlugin.balance.plus(transfer.amount)
      this.pairedPlugin.emit('outgoing_reject', transfer, rejectionReason)
    })
  }
}

class Connector {
  constructor ({ plugin1, plugin2, mps1, mps2, rate, spread }) {
    const rate1 = new BigNumber(rate).times(new BigNumber(1).minus(spread))
    const rate2 = new BigNumber(1).dividedBy(rate).times(new BigNumber(1).plus(spread))

    plugin1.on('incoming_prepare', (transfer) => this.forwardPayment({
      fromPlugin: plugin1,
      toPlugin: plugin2,
      transfer,
      rate: rate1,
      mps: mps1
    }))
    plugin1.on('outgoing_fulfill', (transfer, fulfillment, ilp) => plugin2.fulfillCondition(transfer.id, fulfillment, ilp))
    plugin1.on('outgoing_reject', (transfer, ilp) => plugin2.rejectIncomingTransfer(transfer.id, ilp))

    plugin2.on('incoming_prepare', (transfer) => this.forwardPayment({
      fromPlugin: plugin2,
      toPlugin: plugin1,
      transfer,
      rate: rate2,
      mps: mps2
    }))
    plugin2.on('outgoing_fulfill', (transfer, fulfillment, ilp) => plugin1.fulfillCondition(transfer.id, fulfillment, ilp))
    plugin2.on('outgoing_reject', (transfer, ilp) => plugin1.rejectIncomingTransfer(transfer.id, ilp))
  }

  async forwardPayment ({fromPlugin, toPlugin, transfer, rate, mps}) {
    const outgoingBalance = await toPlugin.getBalance()
    const transferAmount = new BigNumber(transfer.amount)
    const outgoingAmount = transferAmount.times(rate).truncated()
    if (transferAmount.greaterThan(mps)) {
      const data = new oer.Writer()
      data.writeUInt64(transferAmount.toNumber())
      data.writeUInt64(new BigNumber(mps).toNumber())
      fromPlugin.rejectIncomingTransfer(transfer.id, base64url(IlpPacket.serializeIlpError({
        code: 'F08',
        name: 'Payment Too Large',
        data: data.getBuffer(),
        triggeredAt: new Date(),
        triggeredBy: '',
        forwardedBy: []
      })))
    } else if (outgoingAmount.greaterThan(outgoingBalance)) {
      fromPlugin.rejectIncomingTransfer(transfer.id, base64url(IlpPacket.serializeIlpError({
        code: 'T04',
        name: 'Insufficient Liquidity',
        data: Buffer.alloc(0),
        triggeredAt: new Date(),
        triggeredBy: '',
        forwardedBy: []
      })))
    } else {
      const packet = IlpPacket.deserializeIlpPayment(Buffer.from(transfer.ilp, 'base64'))
      toPlugin.sendTransfer(Object.assign({}, transfer, {
        from: toPlugin.getAccount(),
        to: packet.account,
        amount: outgoingAmount.toString('10'),
        expiresAt: new Date(Date.parse(transfer.expiresAt) - 1000).toISOString()
      }))
    }
  }
}

exports.Plugin = Plugin
exports.Connector = Connector
