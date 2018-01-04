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

    assert.typeOf(PSK2.listen, 'function')
    assert.typeOf(PSK2.generateParams, 'function')
  })

  it('exports the constants and encoding functions', function () {
    assert.typeOf(PSK2.encoding.deserializePskPacket, 'function')
    assert.typeOf(PSK2.encoding.serializePskPacket, 'function')

    assert(PSK2.encoding)
  })
})