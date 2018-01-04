import 'mocha'
import * as sinon from 'sinon'
import { assert } from 'chai'
import * as crypto from 'crypto'
import mock = require('mock-require')
import BigNumber from 'bignumber.js'
import * as IlpPacket from 'ilp-packet'
import MockPlugin from './mocks/plugin'

const SHARED_SECRET = Buffer.alloc(32, 0)
const PAYMENT_ID = Buffer.from('465736837f790f773baafd63828f38b6', 'hex')
const QUOTE_CONDITION = Buffer.from('a4d735b6bd09ebbc971b817384e8fa1d110b0df130c16ac4d326f508040acbc1', 'hex')
const NONCE = Buffer.from('6c93ab43f2b70ac9a0d3844f', 'hex')
const MAX_UINT64 = new BigNumber('18446744073709551615')

mock('crypto', {
  ...crypto,
  randomBytes: function (numBytes: number): Buffer {
    switch (numBytes) {
      case 12:
        return NONCE
      case 16:
        return PAYMENT_ID
      case 32:
        return QUOTE_CONDITION
      default:
        return Buffer.alloc(0)
    }
  }
})

import * as sender from '../src/sender'
import * as encoding from '../src/encoding'

describe('Sender', function () {
  beforeEach(function () {
    this.clock = sinon.useFakeTimers(0)
    this.plugin = new MockPlugin(0.5)
  })

  afterEach(function () {
    this.clock.restore()
  })

  describe('quoteSourceAmount', function () {
    beforeEach(function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'F99',
        message: '',
        triggeredBy: 'test.receiver',
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 3,
          sequence: 0,
          paymentId: PAYMENT_ID,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber('5')
        })
      }))
    })

    it('sends an IlpPrepare with amount set to the sourceAmont and the chunkAmount in the PSK data set to the MAX_UINT64 value', async function () {
      const spy = sinon.spy(this.plugin, 'sendData')
      await sender.quoteSourceAmount(this.plugin, {
        sourceAmount: '10',
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver'
      })

      assert(spy.calledWith(IlpPacket.serializeIlpPrepare({
        destination: 'test.receiver',
        amount: '10',
        executionCondition: QUOTE_CONDITION,
        expiresAt: new Date(2000),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 1,
          paymentId: PAYMENT_ID,
          sequence: 0,
          paymentAmount: MAX_UINT64,
          chunkAmount: MAX_UINT64
        })
      })))

      spy.restore()
    })

    it('resolves to a quote response if the receiver responds with a valid PSK response', async function () {
      const result = await sender.quoteSourceAmount(this.plugin, {
        sourceAmount: '10',
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver'
      })

      assert.equal(result.id, PAYMENT_ID.toString('hex'))
      assert.equal(result.destinationAmount, '5')
      assert.equal(result.sourceAmount, '10')
    })

    it('rejects with an error if the response from the receiver is invalid', async function () {
      const wrongSecret = Buffer.from('37b78bee61e7e895d3a0f37fc53eee437a59a946258db2d42483c9ac2fa86e6f', 'hex')
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'F99',
        message: '',
        triggeredBy: 'test.receiver',
        data: encoding.serializePskPacket(wrongSecret, {
          type: 3,
          sequence: 0,
          paymentId: PAYMENT_ID,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber('5')
        })
      }))

      try {
        await sender.quoteSourceAmount(this.plugin, {
          sourceAmount: '10',
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver'
        })
      } catch (err) {
        assert.equal(err.message, 'unable to parse quote response')
        return
      }
      assert(false, 'should not have gotten here')
    })

    it('rejects with an error if it gets an ILP error other than F99', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'T01',
        message: 'ledger unreachable',
        triggeredBy: 'test.connector',
        data: Buffer.alloc(0)
      }))

      try {
        await sender.quoteSourceAmount(this.plugin, {
          sourceAmount: '10',
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver'
        })
      } catch (err) {
        assert.equal(err.message, 'Error getting quote: Got unexpected error code: T01 ledger unreachable')
        return
      }
      assert(false, 'should not have gotten here')
    })
  })

  describe('quoteDestinationAmount', function () {
    beforeEach(function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'F99',
        message: '',
        triggeredBy: 'test.receiver',
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 3,
          sequence: 0,
          paymentId: PAYMENT_ID,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber('500')
        })
      }))
    })

    it('sends an IlpPrepare with amount set to a fixed value and the chunkAmount in the PSK data set to the MAX_UINT64 value', async function () {
      const spy = sinon.spy(this.plugin, 'sendData')
      await sender.quoteDestinationAmount(this.plugin, {
        destinationAmount: '20',
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver'
      })

      assert(spy.calledWith(IlpPacket.serializeIlpPrepare({
        destination: 'test.receiver',
        amount: '1000',
        executionCondition: QUOTE_CONDITION,
        expiresAt: new Date(2000),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 1,
          paymentId: PAYMENT_ID,
          sequence: 0,
          paymentAmount: MAX_UINT64,
          chunkAmount: MAX_UINT64
        })
      })))

      spy.restore()
    })

    it('assumes a linear exchange rate and uses the ratio between amount sent and received to determine the source amount', async function () {
      const result = await sender.quoteDestinationAmount(this.plugin, {
        destinationAmount: '20',
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver'
      })

      assert.equal(result.destinationAmount, '20')
      assert.equal(result.sourceAmount, '40')
    })
  })

  describe('sendSingleChunk', function () {
    beforeEach(function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpFulfill({
        fulfillment: Buffer.from('0de77e566fd39f0b9ea26bb10e4b6aa3ff813eee37758caf0c1adfd69edd572b', 'hex'),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 2,
          paymentId: PAYMENT_ID,
          sequence: 0,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber(55),
          applicationData: Buffer.alloc(0)
        })
      }))
    })

    it('sends an IlpPrepare with the given source amount and minimum destination amount supplied as the chunkAmount', async function () {
      const spy = sinon.spy(this.plugin, 'sendData')

      await sender.sendSingleChunk(this.plugin, {
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver',
        sourceAmount: '100',
        minDestinationAmount: '50'
      })

      assert(spy.calledWith(IlpPacket.serializeIlpPrepare({
        destination: 'test.receiver',
        amount: '100',
        executionCondition: Buffer.from('dbe5899c51056feae0d6b42dc8677f40a5452ca03512f058d95132c2cf5b7bf8', 'hex'),
        expiresAt: new Date(2000),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 1,
          paymentId: PAYMENT_ID,
          sequence: 0,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber(50)
        })
      })))

      spy.restore()
    })

    it('returns the amount that arrived at the destination', async function () {
      const result = await sender.sendSingleChunk(this.plugin, {
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver',
        sourceAmount: '100',
        minDestinationAmount: '50'
      })

      assert.equal(result.id, PAYMENT_ID.toString('hex'))
      assert.equal(result.sourceAmount, '100')
      assert.equal(result.destinationAmount, '55')
      assert.equal(result.chunksFulfilled, 1)
    })

    it('rejects if it receives an invalid fulfillment', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpFulfill({
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0)
      }))

      try {
        await sender.sendSingleChunk(this.plugin, {
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver',
          sourceAmount: '100',
          minDestinationAmount: '50'
        })
      } catch (err) {
        assert.include(err.message, 'Received invalid fulfillment')
        return
      }
      assert(false, 'should not get here')
    })

    it('rejects if the prepare is rejected by the receiver', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'F99',
        message: '',
        triggeredBy: 'test.receiver',
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 3,
          paymentId: PAYMENT_ID,
          sequence: 0,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber('45'),
          applicationData: Buffer.alloc(0)
        })
      }))

      try {
        await sender.sendSingleChunk(this.plugin, {
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver',
          sourceAmount: '100',
          minDestinationAmount: '50'
        })
      } catch (err) {
        assert.include(err.message, 'Error sending payment')
        // assert.include(err.message, 'Receiver says too little arrived. actual: 45, expected: 50')
        return
      }
      assert(false, 'should not get here')
    })

    it('rejects if it gets a non-F99 error', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
        code: 'T02',
        message: 'ledger unreachable',
        triggeredBy: 'test.connector',
        data: Buffer.alloc(0)
      }))

      try {
        await sender.sendSingleChunk(this.plugin, {
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver',
          sourceAmount: '100',
          minDestinationAmount: '50'
        })
      } catch (err) {
        assert.include(err.message, 'Error sending payment')
        // assert.include(err.message, 'Receiver says too little arrived. actual: 45, expected: 50')
        return
      }
      assert(false, 'should not get here')
    })
  })
})
