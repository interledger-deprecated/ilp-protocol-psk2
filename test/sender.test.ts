import 'mocha'
import * as sinon from 'sinon'
import { assert } from 'chai'
import * as crypto from 'crypto'
import mock = require('mock-require')
import BigNumber from 'bignumber.js'
import * as IlpPacket from 'ilp-packet'
import MockPlugin from './mocks/plugin'
import * as ILDCP from 'ilp-protocol-ildcp'

const SHARED_SECRET = Buffer.alloc(32, 0)
const PAYMENT_ID = Buffer.from('465736837f790f773baafd63828f38b6', 'hex')
const QUOTE_CONDITION = Buffer.from('a4d735b6bd09ebbc971b817384e8fa1d110b0df130c16ac4d326f508040acbc1', 'hex')
const NONCE = Buffer.from('6c93ab43f2b70ac9a0d3844f', 'hex')
const MAX_UINT64 = new BigNumber('18446744073709551615')

mock.stopAll()
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
mock.reRequire('../src/encoding')
mock.reRequire('../src/sender')
import * as sender from '../src/sender'
import * as encoding from '../src/encoding'
import { createReceiver } from '../src/receiver'
import { PaymentHandlerParams } from '../src/index'

describe('Sender', function () {
  beforeEach(function () {
    this.setInterval = setInterval
    this.clearInterval = clearInterval
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
          paymentAmount: new BigNumber(0),
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

      assert.deepEqual(result.id, PAYMENT_ID)
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

    it('should allow the user to set the paymentId, sequence, and last chunk boolean', async function () {
      const stub = sinon.stub(this.plugin, 'sendData')
        .resolves(IlpPacket.serializeIlpFulfill({
          fulfillment: Buffer.from('W1FuCUSj7DXLzQMGlWC7HxbTHs6jOVRtAh5uITnmzWY=', 'base64'),
          data: encoding.serializePskPacket(SHARED_SECRET, {
            type: 2,
            paymentId: Buffer.alloc(16, 5),
            sequence: 5,
            paymentAmount: MAX_UINT64,
            chunkAmount: new BigNumber(55),
            applicationData: Buffer.alloc(0)
          })
        }))
      await sender.sendSingleChunk(this.plugin, {
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver',
        sourceAmount: '100',
        minDestinationAmount: '50',
        id: Buffer.alloc(16, 5),
        sequence: 5,
        lastChunk: false
      })

      assert(stub.calledWith(IlpPacket.serializeIlpPrepare({
        destination: 'test.receiver',
        amount: '100',
        executionCondition: Buffer.from('3b06f0bb996ebfebc485ba91418b59e99fa8b0ab610670df1c1a13c34d416c57', 'hex'),
        expiresAt: new Date(2000),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 0,
          paymentId: Buffer.alloc(16, 5),
          sequence: 5,
          paymentAmount: MAX_UINT64,
          chunkAmount: new BigNumber(50)
        })
      })))

      stub.restore()
    })

    it('returns the amount that arrived at the destination', async function () {
      const result = await sender.sendSingleChunk(this.plugin, {
        sharedSecret: SHARED_SECRET,
        destinationAccount: 'test.receiver',
        sourceAmount: '100',
        minDestinationAmount: '50'
      })

      assert.deepEqual(result.id, PAYMENT_ID)
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

    it('rejects if the response is an invalid or unknown ILP packet', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(Buffer.alloc(100, 'FF', 'hex'))

      try {
        await sender.sendSingleChunk(this.plugin, {
          sharedSecret: SHARED_SECRET,
          destinationAccount: 'test.receiver',
          sourceAmount: '100',
          minDestinationAmount: '50'
        })
      } catch (err) {
        assert.include(err.message, 'Packet has invalid type')
        // assert.include(err.message, 'Receiver says too little arrived. actual: 45, expected: 50')
        return
      }
      assert(false, 'should not get here')
    })

    it('rejects if the response is neither an IlpPrepare nor an IlpReject', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpRejection({
        code: 'F00',
        triggeredBy: 'test.receiver',
        message: 'blah',
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
        assert.include(err.message, 'Unexpected type for sendData response: 11')
        return
      }
      assert(false, 'should not get here')
    })

    it('rejects if the PSK response packet sequence does not correspond to the request', async function () {
      this.plugin.sendData = (buffer: Buffer) => Promise.resolve(IlpPacket.serializeIlpFulfill({
        fulfillment: Buffer.from('Ded+Vm/TnwueomuxDktqo/+BPu43dYyvDBrf1p7dVys=', 'base64'),
        data: encoding.serializePskPacket(SHARED_SECRET, {
          type: 3,
          paymentId: PAYMENT_ID,
          sequence: 5,
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
        assert.include(err.message, 'Invalid response from receiver: unexpected PSK packet type. expected: 2, actual: 3')
        // assert.include(err.message, 'Receiver says too little arrived. actual: 45, expected: 50')
        return
      }
      assert(false, 'should not get here')
    })

  })

  describe('Chunked Payments', function () {
    beforeEach(async function () {
      this.sendDataStub = sinon.stub(this.plugin, 'sendData')
        .onFirstCall()
        .resolves(ILDCP.serializeIldcpResponse({
          clientAddress: 'test.receiver',
          assetScale: 9,
          assetCode: 'ABC'
        }))
        .callThrough()

      this.receiver = await createReceiver({
        plugin: this.plugin,
        paymentHandler: (params: PaymentHandlerParams) => {
          params.accept()
        }
      })
      const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
      this.destinationAccount = destinationAccount
      this.sharedSecret = sharedSecret
    })

    describe('sendSourceAmount', function () {
      it('should send chunks until the source amount has been sent', async function () {
        const result = await sender.sendSourceAmount(this.plugin, {
          sharedSecret: this.sharedSecret,
          destinationAccount: this.destinationAccount,
          sourceAmount: 2000
        })

        assert.deepEqual(result, {
          id: PAYMENT_ID,
          sourceAmount: '2000',
          destinationAmount: '1000',
          chunksFulfilled: 2,
          chunksRejected: 0
        })
      })

      it('should increase the chunk size with each fulfilled chunk but reduce the last one to hit the sourceAmount exactly', async function () {
        await sender.sendSourceAmount(this.plugin, {
          sharedSecret: this.sharedSecret,
          destinationAccount: this.destinationAccount,
          sourceAmount: '2500'
        })

        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[1][0]), { amount: '1000' })
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[2][0]), { amount: '1100' })
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[3][0]), { amount: '400' })
      })

      it('should decrease the chunk size and try again if it gets a temporary error', async function () {
        const interval = this.setInterval(() => {
          this.clock.runAll()
        }, 1)
        this.sendDataStub.onThirdCall().resolves(IlpPacket.serializeIlpReject({
          code: 'T00',
          triggeredBy: 'test.connector',
          message: '',
          data: Buffer.alloc(0)
        }))

        await sender.sendSourceAmount(this.plugin, {
          sharedSecret: this.sharedSecret,
          destinationAccount: this.destinationAccount,
          sourceAmount: '2500'
        })

        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[1][0]), { amount: '1000' })
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[2][0]), { amount: '1100' }) // this one fails
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[3][0]), { amount: '550' })
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[4][0]), { amount: '605' })
        assert.deepInclude(IlpPacket.deserializeIlpPrepare(this.sendDataStub.args[5][0]), { amount: '345' })

        this.clearInterval(interval)
      })
    })

    describe('sendDestinationAmount', function () {
      it('should send chunks until the destination amount has been sent', async function () {
        const result = await sender.sendDestinationAmount(this.plugin, {
          sharedSecret: this.sharedSecret,
          destinationAccount: this.destinationAccount,
          destinationAmount: 1000
        })

        assert.deepEqual(result, {
          id: PAYMENT_ID,
          sourceAmount: '2000',
          destinationAmount: '1000',
          chunksFulfilled: 2,
          chunksRejected: 0
        })
      })

      it.skip('should handle changing exchange rates')
      it.skip('should handle rounding errors and try to hit the destination amount exactly')
    })
  })
})

mock.stopAll()
mock.reRequire('crypto')
