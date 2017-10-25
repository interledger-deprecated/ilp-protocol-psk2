const EventEmitter = require('eventemitter2')
const IlpPacket = require('ilp-packet')
const oer = require('oer-utils')
const BigNumber = require('bignumber.js')
const base64url = require('./base64url')

class Plugin extends EventEmitter {
  constructor ({ account, prefix }) {
    super()
    this.transfers = {}
    this.pairedPlugin = null
    this.account = account
    this.prefix = prefix
  }

  linkToOtherPlugin (otherPlugin) {
    this.pairedPlugin = otherPlugin
  }

  getAccount() {
    return this.account
  }

  getInfo() {
    return {
      prefix: this.prefix,
      connectors: [ this.pairedPlugin.account ]
    }
  }

  sendTransfer(transfer) {
    setImmediate(() => {
      this.transfers[transfer.id] = transfer
      this.pairedPlugin.emit('incoming_prepare', transfer)
    })
  }

  fulfillCondition(transferId, fulfillment, ilp ) {
    setImmediate(() => {
      this.pairedPlugin.emit('outgoing_fulfill', this.pairedPlugin.transfers[transferId], fulfillment, ilp)
    })
  }

  rejectIncomingTransfer(transferId, rejectionReason) {
    setImmediate(() => {
      this.pairedPlugin.emit('outgoing_reject', this.pairedPlugin.transfers[transferId], rejectionReason)
    })
  }
}

class Connector {
  constructor ({ plugin1, plugin2, mps1, mps2, rate, spread }) {
    const rate1 = new BigNumber(rate).times(new BigNumber(1).plus(spread))
    const rate2 = new BigNumber(1).dividedBy(rate).times(new BigNumber(1).minus(spread))

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

  forwardPayment ({fromPlugin, toPlugin, transfer, rate, mps}) {
    if (new BigNumber(transfer.amount).greaterThan(mps)) {
      const data = new oer.Writer()
      data.writeUInt64(parseInt(transfer.amount))
      data.writeUInt64(new BigNumber(mps).toNumber())
      fromPlugin.rejectIncomingTransfer(transfer.id, base64url(IlpPacket.serializeIlpError({
        code: 'F08',
        name: 'Payment Too Large',
        data: data.getBuffer(),
        triggeredAt: new Date(),
        triggeredBy: '',
        forwardedBy: []
      })))
    } else {
      toPlugin.sendTransfer(Object.assign({}, transfer, {
        amount: rate.times(transfer.amount).truncated(),
        expiresAt: new Date(Date.parse(transfer.expiresAt) - 1000).toISOString()
      }))
    }
  }
        //this.emit('outgoing_reject', transfer, base64url(IlpPacket.serializeIlpError({
          //code: 'T04',
          //name: 'Insufficient Liquidity',
          //data: Buffer.alloc(0),
          //triggeredAt: new Date(),
          //triggeredBy: '',
          //forwardedBy: []
        //})))
}

exports.Plugin = Plugin
exports.Connector = Connector
