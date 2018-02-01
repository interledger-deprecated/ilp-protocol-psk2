import 'mocha'
import * as sinon from 'sinon'
import { assert } from 'chai'
import * as PSK2 from '../src/index'

describe('Exports', function () {
  it('exports the sender and receiver functions directly', function () {
    assert.typeOf(PSK2.sendDestinationAmount, 'function')
    assert.typeOf(PSK2.sendSourceAmount, 'function')
    assert.typeOf(PSK2.sendSingleChunk, 'function')
    assert.typeOf(PSK2.quoteDestinationAmount, 'function')
    assert.typeOf(PSK2.quoteSourceAmount, 'function')

    assert.typeOf(PSK2.Receiver, 'function')
    assert.typeOf(PSK2.createReceiver, 'function')
  })

  it('exports the packet types and encoding functions', function () {
    assert.typeOf(PSK2.deserializePskPacket, 'function')
    assert.typeOf(PSK2.serializePskPacket, 'function')
    assert.typeOf(PSK2.deserializeLegacyPskPacket, 'function')
    assert.typeOf(PSK2.serializeLegacyPskPacket, 'function')
    assert.typeOf(PSK2.TYPE_PSK2_CHUNK, 'number')
  })
})
