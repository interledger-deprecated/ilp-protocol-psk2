import 'mocha'
import * as sinon from 'sinon'
import { assert } from 'chai'
import * as crypto from 'crypto'
import mock = require('mock-require')
import BigNumber from 'bignumber.js'
import * as IlpPacket from 'ilp-packet'
import MockPlugin from './mocks/plugin'
import { Receiver, createReceiver, PaymentReceived, PaymentHandlerParams, RequestHandlerParams } from '../src/receiver'
import { sendRequest, quoteSourceAmount, sendSingleChunk } from '../src/sender'
import * as encoding from '../src/encoding'
import * as ILDCP from 'ilp-protocol-ildcp'
import { MAX_UINT64, TYPE_PSK2_FULFILLMENT, TYPE_PSK2_REJECT } from '../src/constants'
import * as condition from '../src/condition'

describe('Receiver', function () {
  beforeEach(function () {
    this.plugin = new MockPlugin(0.5)
    this.ildcpStub = sinon.stub(this.plugin, 'sendData')
      .onFirstCall()
      .resolves(ILDCP.serializeIldcpResponse({
        clientAddress: 'test.receiver',
        assetScale: 9,
        assetCode: 'ABC'
      }))
      .callThrough()
    this.receiver = new Receiver(this.plugin, Buffer.alloc(32))
  })

  describe('connect', function () {
    it('should connect the plugin', async function () {
      const spy = sinon.spy(this.plugin, 'connect')
      await this.receiver.connect()
      assert(spy.called)
    })

    it('should use ILDCP to get the receiver ILP address', async function () {
      await this.receiver.connect()
      assert(this.ildcpStub.called)
      // This will throw if it can't parse it
      ILDCP.deserializeIldcpRequest(this.ildcpStub.args[0][0])
    })
  })

  describe('disconnect', function () {
    it('should disconnect the plugin and deregister the data handler', async function () {
      const disconnect = sinon.spy(this.plugin, 'disconnect')
      const deregister = sinon.spy(this.plugin, 'deregisterDataHandler')
      await this.receiver.disconnect()
      assert(disconnect.called)
      assert(deregister.called)
    })
  })

  describe('generateAddressAndSecret', function () {
    it('should throw if the receiver is not connected', function () {
      try {
        this.receiver.generateAddressAndSecret()
      } catch (err) {
        assert.equal(err.message, 'Receiver must be connected')
        return
      }
      assert(false, 'should not get here')
    })

    it('should append the token to the address returned by ILDCP', async function () {
      await this.receiver.connect()
      const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
      assert.match(destinationAccount, /^test\.receiver\.[a-zA-Z0-9_-]+$/)
    })

    it('should create a unique shared secret every time it is called', async function () {
      await this.receiver.connect()
      const call1 = this.receiver.generateAddressAndSecret()
      const call2 = this.receiver.generateAddressAndSecret()
      assert.notEqual(call1.destinationAccount, call2.destinationAccount)
      assert.notEqual(call1.sharedSecret, call2.sharedSecret)
    })
  })

  describe('registerRequestHandler', function () {
    it('should not allow you to register both a request and payment handler', async function () {
      this.receiver.registerPaymentHandler(() => undefined)
      assert.throws(() => this.receiver.registerRequestHandler(() => undefined))

      this.receiver.deregisterPaymentHandler()
      this.receiver.registerRequestHandler(() => undefined)
      assert.throws(() => this.receiver.registerPaymentHandler(() => undefined))
    })
  })

  describe('registerRequestHandlerForSecret', function () {
    it('should not allow you to register both a request and payment handler', async function () {
      this.receiver.registerPaymentHandler(() => undefined)
      assert.throws(() => this.receiver.registerRequestHandlerForSecret(Buffer.alloc(32), () => undefined))

      this.receiver.deregisterPaymentHandler()

      this.receiver.registerRequestHandlerForSecret(Buffer.alloc(32), () => undefined)
      assert.throws(() => this.receiver.registerPaymentHandler(() => undefined))
    })

    it('should not allow you to register two handlers for the same secret without deregistering one first', async function () {
      const handlerA = (params: RequestHandlerParams) => params.reject()
      const handlerB = (params: RequestHandlerParams) => params.accept()
      const sharedSecret = Buffer.alloc(32)
      this.receiver.registerRequestHandlerForSecret(sharedSecret, handlerA)
      assert.throws(() => this.receiver.registerRequestHandlerForSecret(sharedSecret, handlerB))

      this.receiver.deregisterRequestHandlerForSecret(sharedSecret)

      assert.doesNotThrow(() => this.receiver.registerRequestHandlerForSecret(sharedSecret, handlerB))
    })

    it('should not do anything if you try to deregister a handler for a secret there was no handler for', async function () {
      assert.doesNotThrow(() => this.receiver.deregisterRequestHandlerForSecret(Buffer.alloc(32)))
    })
  })

  describe('handleData', function () {
    beforeEach(async function () {
      await this.receiver.connect()
    })

    describe('RequestHandler API', function () {
      beforeEach(function () {
        this.receiver.registerRequestHandler(() => undefined)
        const { sharedSecret, destinationAccount } = this.receiver.generateAddressAndSecret()
        this.sharedSecret = sharedSecret
        this.destinationAccount = destinationAccount
        this.pskRequest = {
          type: encoding.Type.Request,
          requestId: 1000,
          amount: new BigNumber(50),
          data: Buffer.from('hello')
        }
        this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
        this.fulfillment = condition.dataToFulfillment(this.sharedSecret, this.pskRequestBuffer)
        this.executionCondition = condition.fulfillmentToCondition(this.fulfillment)
        this.prepare = {
          destination: this.destinationAccount,
          amount: '100',
          data: this.pskRequestBuffer,
          executionCondition: this.executionCondition,
          expiresAt: new Date(Date.now() + 3000)
        }
      })

      describe('invalid packets', function () {
        it('should reject if it gets anything other than an IlpPrepare packet', async function () {
          this.receiver.registerRequestHandler(() => undefined)
          const response = await this.plugin.sendData(IlpPacket.serializeIlpForwardedPayment({
            account: 'test.receiver',
            data: Buffer.alloc(32)
          }))
          assert(response)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Packet is not an IlpPrepare',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if the data has been tampered with', async function () {
          this.prepare.data[10] = ~this.prepare.data[10]
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Unable to parse data',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if the PSK packet type is unknown', async function () {
          this.pskRequest.type = 7
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          this.fulfillment = condition.dataToFulfillment(this.sharedSecret, this.pskRequestBuffer)
          this.executionCondition = condition.fulfillmentToCondition(this.fulfillment)
          this.prepare = {
            destination: this.destinationAccount,
            amount: '100',
            data: this.pskRequestBuffer,
            executionCondition: this.executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Unable to parse data',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if the PSK packet is not a request type', async function () {
          this.pskRequest.type = encoding.Type.Response
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          this.fulfillment = condition.dataToFulfillment(this.sharedSecret, this.pskRequestBuffer)
          this.executionCondition = condition.fulfillmentToCondition(this.fulfillment)
          this.prepare = {
            destination: this.destinationAccount,
            amount: '100',
            data: this.pskRequestBuffer,
            executionCondition: this.executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Unexpected packet type',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
          this.plugin.hello = 'foo'
        })

        it('should reject if the amount received is less than specified in the PSK Request', async function () {
          // Note: We should be able to use the fixtures attached to this but for some reason this test fails unless these are copied here
          this.pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          this.fulfillment = condition.dataToFulfillment(this.sharedSecret, this.pskRequestBuffer)
          this.executionCondition = condition.fulfillmentToCondition(this.fulfillment)
          this.prepare = {
            destination: this.destinationAccount,
            amount: '99',
            data: this.pskRequestBuffer,
            executionCondition: this.executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const parsed = IlpPacket.deserializeIlpReject(response)
          assert.equal(parsed.message, '')
          assert.equal(parsed.code, 'F99')
          assert.notEqual(parsed.data.length, 0)
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, parsed.data)
          assert.equal(pskResponse.requestId, this.pskRequest.requestId)
          assert.equal(pskResponse.amount.toString(10), '49')
        })

        it('should reject (with the PSK rejection packet attached) if it cannot properly generate the fulfillment', async function () {
          // Note: We should be able to use the fixtures attached to this but for some reason this test fails unless these are copied here
          this.pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          const executionCondition = Buffer.alloc(32, 0)
          const prepare = {
            destination: this.destinationAccount,
            amount: '100',
            data: this.pskRequestBuffer,
            executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
          const parsed = IlpPacket.deserializeIlpReject(response)
          assert.equal(parsed.code, 'F05')
          assert.equal(parsed.message, 'Condition generated does not match prepare')
          assert.notEqual(parsed.data.length, 0)
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, parsed.data)
          assert.equal(pskResponse.amount.toString(10), '50')
        })

        it('should call the requestHandler with the attached data (and an amount of 0) even if it cannot generate the fulfillment', async function () {
          const spy = sinon.spy()
          this.receiver.deregisterRequestHandler()
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            spy(params)
            params.reject(Buffer.from('got it'))
          })
          // Note: We should be able to use the fixtures attached to this but for some reason this test fails unless these are copied here
          this.pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          const executionCondition = Buffer.alloc(32, 0)
          const prepare = {
            destination: this.destinationAccount,
            amount: '100',
            data: this.pskRequestBuffer,
            executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
          assert(spy.called)
          const parsed = IlpPacket.deserializeIlpReject(response)
          assert.notEqual(parsed.data.length, 0)
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, parsed.data)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString(), 'got it')
          assert.strictEqual(spy.args[0][0].isFulfillable, false)
          assert.strictEqual(spy.args[0][0].amount.toString(), '0')
        })

        it('should reject even if the requestHandler calls accpet', async function () {
          const spy = sinon.spy()
          this.receiver.deregisterRequestHandler()
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            spy(params)
            params.accept(Buffer.from('got it'))
          })
          // Note: We should be able to use the fixtures attached to this but for some reason this test fails unless these are copied here
          this.pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          this.pskRequestBuffer = encoding.serializePskPacket(this.sharedSecret, this.pskRequest)
          const executionCondition = Buffer.alloc(32, 0)
          const prepare = {
            destination: this.destinationAccount,
            amount: '100',
            data: this.pskRequestBuffer,
            executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
          assert(spy.called)
          const parsed = IlpPacket.deserializeIlpReject(response)
          assert.notEqual(parsed.data.length, 0)
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, parsed.data)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString(), '')
        })
      })

      describe('valid packets', function () {
        beforeEach(function () {
          this.receiver.deregisterRequestHandler()
        })

        it('should accept packets sent by sendRequest', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            params.accept(Buffer.from('thanks!'))
          })
          const result = await sendRequest(this.plugin, {
            destinationAccount: this.destinationAccount,
            sharedSecret: this.sharedSecret,
            sourceAmount: '10',
            minDestinationAmount: '1'
          })
          assert.equal(result.fulfilled, true)
          assert.equal(result.data.toString('utf8'), 'thanks!')
          assert.equal(result.destinationAmount.toString(10), '5')
        })

        it('should call the RequestHandler with the amount and data', async function () {
          const spy = sinon.spy()
          this.receiver.registerRequestHandler(spy)
          await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          assert.equal(spy.args[0][0].amount.toString(10), '50')
          assert.equal(spy.args[0][0].data.toString('utf8'), 'hello')
        })

        it('should reject the packet if the user calls reject', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => params.reject(Buffer.from('nope')))
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpReject(response).data)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString('utf8'), 'nope')
        })

        it('should reject the packet if there is an error thrown in the request handler', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => { throw new Error('oops') })
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpReject(response).data)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString('utf8'), '')
        })

        it('should reject the packet if the user does not call accept or reject', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => { return })
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpReject(response).data)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString('utf8'), '')
        })

        it('should fulfill packets if the user calls accept', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => Promise.resolve().then(() => params.accept(Buffer.from('yup'))))
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpFulfill(response).data)
          assert.equal(pskResponse.requestId, this.pskRequest.requestId)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString('utf8'), 'yup')
        })

        it('should throw an error if the user calls accept and reject', async function () {
          let threw = false
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            params.accept(Buffer.from('yup'))
            try {
              params.reject(Buffer.from('nope'))
            } catch (err) {
              threw = true
              throw err
            }
          })
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpFulfill(response).data)
          assert.equal(pskResponse.data.toString('utf8'), 'yup')
          assert.equal(threw, true)
        })

        it('should be okay with exta segments being appended to the destinationAccount', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => Promise.resolve().then(() => params.accept(Buffer.from('yup'))))
          this.prepare.destination = this.prepare.destination + '.some.other.stuff'
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(this.prepare))
          const pskResponse = encoding.deserializePskPacket(this.sharedSecret, IlpPacket.deserializeIlpFulfill(response).data)
          assert.equal(pskResponse.type, 5)
          assert.equal(pskResponse.amount.toString(10), '50')
          assert.equal(pskResponse.data.toString('utf8'), 'yup')
        })

        it('should pass the keyId to the request handler if one was passed in to createAddressAndSecret', async function () {
          const keyId = Buffer.from('invoice12345')
          const { sharedSecret, destinationAccount } = this.receiver.generateAddressAndSecret(keyId)
          const pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          const pskRequestBuffer = encoding.serializePskPacket(sharedSecret, pskRequest)
          const fulfillment = condition.dataToFulfillment(sharedSecret, pskRequestBuffer)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = {
            destination: destinationAccount,
            amount: '100',
            data: pskRequestBuffer,
            executionCondition: executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }

          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            assert.deepEqual(params.keyId, keyId)
            params.accept(Buffer.from('yup', 'utf8'))
          })
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
          const pskResponse = encoding.deserializePskPacket(sharedSecret, IlpPacket.deserializeIlpFulfill(response).data)
          assert.equal(pskResponse.type, 5)
        })

        it('should reject if the keyId is modified', async function () {
          const keyId = Buffer.from('invoice12345')
          const { sharedSecret, destinationAccount } = this.receiver.generateAddressAndSecret(keyId)
          const pskRequest = {
            type: encoding.Type.Request,
            requestId: 1000,
            amount: new BigNumber(50),
            data: Buffer.from('hello')
          }
          const pskRequestBuffer = encoding.serializePskPacket(sharedSecret, pskRequest)
          const fulfillment = condition.dataToFulfillment(sharedSecret, pskRequestBuffer)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const modified = destinationAccount.slice(0, -1) + 'z'
          const prepare = {
            destination: modified,
            amount: '100',
            data: pskRequestBuffer,
            executionCondition: executionCondition,
            expiresAt: new Date(Date.now() + 3000)
          }

          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare(prepare))
          const packet = IlpPacket.deserializeIlpReject(response)
          assert.equal(packet.code, 'F06')
          assert.equal(packet.message, 'Unable to parse data')
        })
      })

      describe('legacy PSK packets', function () {
        it('should reject if the prepare amount is less than the chunkAmount', async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(2000),
            executionCondition: Buffer.alloc(32),
            data: encoding.serializeLegacyPskPacket(sharedSecret, {
              type: 0,
              paymentId: Buffer.alloc(16),
              sequence: 0,
              paymentAmount: MAX_UINT64,
              chunkAmount: MAX_UINT64,
              applicationData: Buffer.alloc(0)
            })
          }))
          assert(response)
          const reject = IlpPacket.deserializeIlpReject(response)
          assert.equal(reject.code, 'F99')
          assert.equal(reject.message, '')
          const pskResponse = encoding.deserializeLegacyPskPacket(sharedSecret, reject.data)
          assert.deepEqual(pskResponse, {
            type: 3,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(0),
            chunkAmount: new BigNumber(50),
            applicationData: Buffer.alloc(0)
          })
        })

        it('should fulfill with the right PSK packet type if the user calls accept', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => Promise.resolve().then(() => params.accept(Buffer.from('yup'))))
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const legacy = encoding.serializeLegacyPskPacket(sharedSecret, {
            type: 1,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: MAX_UINT64,
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(sharedSecret, legacy)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition,
            data: legacy
          })
          const response = await this.plugin.sendData(prepare)
          const fulfill = IlpPacket.deserializeIlpFulfill(response)
          const parsed = encoding.deserializeLegacyPskPacket(sharedSecret, fulfill.data)
          assert.equal(parsed.type, TYPE_PSK2_FULFILLMENT)
          assert.equal(parsed.applicationData && parsed.applicationData.toString('utf8'), '')
        })

        it('should reject with the correct packet type if the user calls reject', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => Promise.resolve().then(() => params.reject(Buffer.from('nope'))))
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const legacy = encoding.serializeLegacyPskPacket(sharedSecret, {
            type: 1,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: MAX_UINT64,
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(sharedSecret, legacy)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition,
            data: legacy
          })
          const response = await this.plugin.sendData(prepare)
          const reject = IlpPacket.deserializeIlpReject(response)
          const parsed = encoding.deserializeLegacyPskPacket(sharedSecret, reject.data)
          assert.equal(parsed.type, TYPE_PSK2_REJECT)
          assert.equal(parsed.applicationData && parsed.applicationData.toString('utf8'), '')
        })

        it('should work with quoteSourceAmount', async function () {
          const { sourceAmount, destinationAmount } = await quoteSourceAmount(this.plugin, {
            destinationAccount: this.destinationAccount,
            sharedSecret: this.sharedSecret,
            sourceAmount: '100'
          })
          assert.equal(destinationAmount, '50')
        })

        it('should work with sendSingleChunk', async function () {
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => Promise.resolve().then(() => params.accept(Buffer.from('yup'))))
          const result = await sendSingleChunk(this.plugin, {
            destinationAccount: this.destinationAccount,
            sharedSecret: this.sharedSecret,
            sourceAmount: '100'
          })
          assert.equal(result.chunksFulfilled, 1)
        })
      })

      describe('Listening with a custom sharedSecret', function () {
        it('should call the given requestHandler instead of the normal one', async function () {
          const normalSpy = sinon.spy()
          const specificSpy = sinon.spy()
          this.receiver.registerRequestHandler((params: RequestHandlerParams) => {
            params.reject()
            normalSpy()
          })
          const sharedSecret = Buffer.alloc(32, 'FF', 'hex')
          const { destinationAccount } = this.receiver.registerRequestHandlerForSecret(sharedSecret, (params: RequestHandlerParams) => {
            params.accept()
            specificSpy()
          })

          const result = await sendRequest(this.plugin, {
            destinationAccount,
            sharedSecret,
            sourceAmount: '100',
          })

          assert(normalSpy.notCalled)
          assert(specificSpy.called)
        })
      })
    })

    describe('legacy PaymentHandler API', function () {
      describe('invalid packets', function () {
        it('should reject if it gets anything other than an IlpPrepare packet', async function () {
          const response = await this.plugin.sendData(IlpPacket.serializeIlpForwardedPayment({
            account: 'test.receiver',
            data: Buffer.alloc(32)
          }))
          assert(response)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Packet is not an IlpPrepare',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if it cannot decrypt the data', async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '1',
            expiresAt: new Date(2000),
            executionCondition: Buffer.alloc(32),
            data: Buffer.alloc(32)
          }))
          assert(response)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Unable to parse data',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if it does not know the PSK packet type', async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '1',
            expiresAt: new Date(2000),
            executionCondition: Buffer.alloc(32),
            data: encoding.serializeLegacyPskPacket(sharedSecret, {
              type: 4,
              paymentId: Buffer.alloc(16),
              sequence: 0,
              paymentAmount: MAX_UINT64,
              chunkAmount: MAX_UINT64,
              applicationData: Buffer.alloc(0)
            })
          }))
          assert(response)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F06',
            message: 'Unexpected request type',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject if the prepare amount is lower than the chunk amount specified in the PSK data (and the response should say how much arrived)', async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(2000),
            executionCondition: Buffer.alloc(32),
            data: encoding.serializeLegacyPskPacket(sharedSecret, {
              type: 0,
              paymentId: Buffer.alloc(16),
              sequence: 0,
              paymentAmount: MAX_UINT64,
              chunkAmount: MAX_UINT64,
              applicationData: Buffer.alloc(0)
            })
          }))
          assert(response)
          const reject = IlpPacket.deserializeIlpReject(response)
          assert.equal(reject.code, 'F99')
          assert.equal(reject.message, '')
          const pskResponse = encoding.deserializeLegacyPskPacket(sharedSecret, reject.data)
          assert.deepEqual(pskResponse, {
            type: 3,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(0),
            chunkAmount: new BigNumber(50),
            applicationData: Buffer.alloc(0)
          })
        })

        it('should reject if it cannot regenerate the fulfillment from the PSK data', async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const response = await this.plugin.sendData(IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(2000),
            executionCondition: Buffer.alloc(32),
            data: encoding.serializeLegacyPskPacket(sharedSecret, {
              type: 0,
              paymentId: Buffer.alloc(16),
              sequence: 0,
              paymentAmount: MAX_UINT64,
              chunkAmount: new BigNumber(50),
              applicationData: Buffer.alloc(0)
            })
          }))
          assert(response)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F05',
            message: 'condition generated does not match prepare',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })
      })

      describe('valid one-off packets', function () {
        beforeEach(function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          const pskRequest = encoding.serializeLegacyPskPacket(sharedSecret, {
            type: 1,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: MAX_UINT64,
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          this.fulfillment = condition.dataToFulfillment(sharedSecret, pskRequest)
          const executionCondition = condition.fulfillmentToCondition(this.fulfillment)
          this.prepare = IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition,
            data: pskRequest
          })
        })

        it('should fulfill a payment if the payment handler accepts it', async function () {
          this.receiver.registerPaymentHandler(async (params: PaymentHandlerParams) => {
            await params.accept()
          })
          const response = await this.plugin.sendData(this.prepare)

          assert.equal(response[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.deepEqual(IlpPacket.deserializeIlpFulfill(response).fulfillment, this.fulfillment)
        })

        it('should reject payments if the payment handler calls reject', async function () {
          this.receiver.registerPaymentHandler(async (params: PaymentHandlerParams) => {
            await params.reject('unwanted')
          })
          const response = await this.plugin.sendData(this.prepare)

          assert.equal(response[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F99',
            message: 'unwanted',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject payments if there is an error thrown in the payment handler', async function () {
          this.receiver.registerPaymentHandler(async (params: PaymentHandlerParams) => {
            throw new Error('some error')
          })
          const response = await this.plugin.sendData(this.prepare)

          assert.equal(response[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F99',
            message: 'some error',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject payments if the payment handler finishes without accept being called', async function () {
          this.receiver.registerPaymentHandler(async (params: PaymentHandlerParams) => {
            return
          })
          const response = await this.plugin.sendData(this.prepare)

          assert.equal(response[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F99',
            message: 'receiver did not accept the payment',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })

        it('should reject payments if there is no payment handler registered', async function () {
          this.receiver.deregisterPaymentHandler()
          const response = await this.plugin.sendData(this.prepare)

          assert.equal(response[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.deepEqual(IlpPacket.deserializeIlpReject(response), {
            code: 'F99',
            message: 'Receiver has no payment handler registered',
            triggeredBy: 'test.receiver',
            data: Buffer.alloc(0)
          })
        })
      })

      describe('multiple chunks', function () {
        beforeEach(async function () {
          const { destinationAccount, sharedSecret } = this.receiver.generateAddressAndSecret()
          this.destinationAccount = destinationAccount
          this.sharedSecret = sharedSecret
          const pskRequest1 = encoding.serializeLegacyPskPacket(sharedSecret, {
            type: 0,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment1 = condition.dataToFulfillment(sharedSecret, pskRequest1)
          const executionCondition1 = condition.fulfillmentToCondition(fulfillment1)
          this.prepare1 = IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition1,
            data: pskRequest1
          })
          const pskRequest2 = encoding.serializeLegacyPskPacket(sharedSecret, {
            type: 0,
            paymentId: Buffer.alloc(16),
            sequence: 1,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment2 = condition.dataToFulfillment(sharedSecret, pskRequest2)
          const executionCondition2 = condition.fulfillmentToCondition(fulfillment2)
          this.prepare2 = IlpPacket.serializeIlpPrepare({
            destination: destinationAccount,
            amount: '200',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition2,
            data: pskRequest2
          })
        })

        it('should call the payment handler on the first chunk', async function () {
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler(spy)
          await this.plugin.sendData(this.prepare1)
          assert.typeOf(spy.args[0][0].accept, 'function')
          assert.typeOf(spy.args[0][0].reject, 'function')
          assert.typeOf(spy.args[0][0].acceptSingleChunk, 'function')
          assert.typeOf(spy.args[0][0].rejectSingleChunk, 'function')
          assert.typeOf(spy.args[0][0].prepare, 'object')
          assert.equal(spy.args[0][0].prepare.amount, '50')
          assert(Buffer.isBuffer(spy.args[0][0].id))
        })

        it('should accept the next chunks if the receiver calls accpet', async function () {
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            params.accept()
            spy()
          })
          const result1 = await this.plugin.sendData(this.prepare1)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(spy.callCount, 1)
        })

        it('should resolve the Promise returned by the accept function when the payment has been fully received', async function () {
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler(async (params: PaymentHandlerParams) => {
            const paymentResult = await params.accept()
            spy(paymentResult)
          })

          const pskRequest = encoding.serializeLegacyPskPacket(this.sharedSecret, {
            type: 0,
            paymentId: Buffer.alloc(16),
            sequence: 2,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(this.sharedSecret, pskRequest)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare3 = IlpPacket.serializeIlpPrepare({
            destination: this.destinationAccount,
            amount: '1002', // plugin applies 0.5 exchange rate
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition,
            data: pskRequest
          })

          const result1 = await this.plugin.sendData(this.prepare1)
          const result2 = await this.plugin.sendData(this.prepare2)
          const result3 = await this.plugin.sendData(prepare3)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result3[0], IlpPacket.Type.TYPE_ILP_FULFILL)

          // The payment result promise is resolved without being awaited so it'll only happen on the next tick of the event loop
          await new Promise((resolve, reject) => setImmediate(resolve))

          assert.equal(spy.callCount, 1)
          assert.deepEqual(spy.args[0][0], {
            id: Buffer.alloc(16),
            chunksFulfilled: 3,
            chunksRejected: 0,
            expectedAmount: '500',
            receivedAmount: '651'
          })
        })

        it('should reject all chunks if the receiver calls reject', async function () {
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            spy()
            params.reject('nop')
          })
          const result1 = await this.plugin.sendData(this.prepare1)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.equal(spy.callCount, 1)
        })

        it('should not accept any more chunks after the payment amount has been received', async function () {
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            params.accept()
          })
          const pskRequest = encoding.serializeLegacyPskPacket(this.sharedSecret, {
            type: 0,
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(this.sharedSecret, pskRequest)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = IlpPacket.serializeIlpPrepare({
            destination: this.destinationAccount,
            amount: '1002', // plugin applies 0.5 exchange rate
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition,
            data: pskRequest
          })
          const result1 = await this.plugin.sendData(prepare)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_REJECT)
        })

        it('should not accept more chunks after the last chunk has been received', async function () {
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            params.accept()
          })
          const pskRequest = encoding.serializeLegacyPskPacket(this.sharedSecret, {
            type: 1, // last chunk
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(this.sharedSecret, pskRequest)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = IlpPacket.serializeIlpPrepare({
            destination: this.destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition,
            data: pskRequest
          })
          const result1 = await this.plugin.sendData(prepare)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_REJECT)
        })

        it('should accept one chunk and call the payment handler again if the user calls acceptSingleChunk', async function () {
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            params.acceptSingleChunk()
            spy()
          })
          const result1 = await this.plugin.sendData(this.prepare1)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(spy.callCount, 2)
        })

        it('should accept a single-chunk payment if the user calls acceptSingleChunk', async function () {
          // Previously this would throw because the finishedPromise was only set by the accept method, not acceptSingleChunk
          const spy = sinon.spy()
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            params.acceptSingleChunk()
            spy()
          })
          const pskRequest = encoding.serializeLegacyPskPacket(this.sharedSecret, {
            type: 1, // last chunk
            paymentId: Buffer.alloc(16),
            sequence: 0,
            paymentAmount: new BigNumber(500),
            chunkAmount: new BigNumber(0),
            applicationData: Buffer.alloc(0)
          })
          const fulfillment = condition.dataToFulfillment(this.sharedSecret, pskRequest)
          const executionCondition = condition.fulfillmentToCondition(fulfillment)
          const prepare = IlpPacket.serializeIlpPrepare({
            destination: this.destinationAccount,
            amount: '100',
            expiresAt: new Date(Date.now() + 2000),
            executionCondition: executionCondition,
            data: pskRequest
          })
          const result1 = await this.plugin.sendData(prepare)
          assert.equal(spy.callCount, 1)
        })

        it('should reject one chunk and call the payment handler again if the user calls rejectSingleChunk', async function () {
          let callCount = 0
          this.receiver.registerPaymentHandler((params: PaymentHandlerParams) => {
            if (++callCount === 1) {
              params.rejectSingleChunk('nope')
            } else {
              params.acceptSingleChunk()
            }
          })
          const result1 = await this.plugin.sendData(this.prepare1)
          const result2 = await this.plugin.sendData(this.prepare2)

          assert.equal(result1[0], IlpPacket.Type.TYPE_ILP_REJECT)
          assert.equal(result2[0], IlpPacket.Type.TYPE_ILP_FULFILL)
          assert.equal(callCount, 2)
        })

        it.skip('should track payment ids separately for each token / sender')
      })
    })
  })
})

describe('createReceiver', function () {
  beforeEach(function () {
    this.plugin = new MockPlugin(0.5)
    this.ildcpStub = sinon.stub(this.plugin, 'sendData')
      .onFirstCall()
      .resolves(ILDCP.serializeIldcpResponse({
        clientAddress: 'test.receiver',
        assetScale: 9,
        assetCode: 'ABC'
      }))
  })

  it('should return a new, connected receiver with a random secret', async function () {
    const receiver = await createReceiver({
      plugin: this.plugin,
      paymentHandler: (params: PaymentHandlerParams) => params.accept().then(function () { return })
    })
    assert(this.plugin.isConnected())
    assert(receiver.isConnected())
    assert.notEqual(this.plugin.dataHandler, this.plugin.defaultDataHandler)
  })
})
