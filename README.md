# PSKv2
> Javascript implementation of the [Pre-Shared Key V2](https://github.com/interledger/rfcs/pull/351) Interledger Transport Protocol.

[![CircleCI](https://circleci.com/gh/emschwartz/ilp-protocol-psk2.svg?style=shield)](https://circleci.com/gh/emschwartz/ilp-protocol-psk2)
[![codecov](https://codecov.io/gh/emschwartz/ilp-protocol-psk2/branch/master/graph/badge.svg)](https://codecov.io/gh/emschwartz/ilp-protocol-psk2)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

## Features

- End-to-End Quoting
- Single Payments
- Streaming Payments
- **(Experimental)** Chunked Payments

## Installation

```shell
npm install ilp-protocol-psk2
```

## API Documentation

See https://emschwartz.github.io/ilp-protocol-psk2

## Usage

### Creating a Receiver

Uses [`createReceiver`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_receiver_.html#createreceiver) and [`Receiver.generateAddressAndSecret`](https://emschwartz.github.io/ilp-protocol-psk2/classes/_receiver_.receiver.html#generateaddressandsecret).

```typescript
import { createReceiver } from 'ilp-protocol-psk2'
const receiver = await createReceiver({
  plugin: myLedgerPlugin,
  paymentHandler: async (params) => {
    // Accept all incoming payments
    const result = await params.accept()
    console.log('Got payment for:', result.receivedAmount)
  }
})

const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()
// Give these two values to a sender to enable them to send payments to this Receiver
```

### Sending a Single Payment

Uses [`sendSingleChunk`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_sender_.html#sendsinglechunk) and [`quoteDestinationAmount`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_sender_.html#quotedestinationamount).

```typescript
import { sendSingleChunk, quoteDestinationAmount } from 'ilp-protocol-psk2'

// These values must be communicated beforehand for the sender to send a payment
const { destinationAccount, sharedSecret } = await getAddressAndSecretFromReceiver()

const { sourceAmount } = await quoteDestinationAmount(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  destinationAmount: '1000'
})

const result = await sendSingleChunk(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  sourceAmount,
  minDestinationAmount: '999'
})
console.log(`Sent payment of ${result.sourceAmount}, receiver got ${result.destinationAmount}`)
```

### Sending a Streaming Payment

Uses [`sendSingleChunk`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_sender_.html#sendsinglechunk).

```typescript
import { randomBytes } from 'crypto'
import { sendSingleChunk } from 'ilp-protocol-psk2'

// These values must be communicated beforehand for the sender to send a payment
const { destinationAccount, sharedSecret } = await getAddressAndSecretFromReceiver

const id = randomBytes(16)
let sequence = 0
const firstChunkResult = await sendSingleChunk(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  sourceAmount,
  minDestinationAmount: '0',
  id,
  sequence,
  lastChunk: false
})

// Repeat as many times as desired, incrementing the sequence each time
// Note that the path exchange rate can be determined by dividing the destination amount returned by the chunk amount sent

const lastChunkResult = await sendSingleChunk(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  sourceAmount,
  minDestinationAmount: '0',
  id,
  sequence,
  lastChunk: true
})
```

### Experimental Chunked Payments

**WARNING:** PSK2 Chunked Payments are experimental. Money can be lost if an error occurs mid-payment or if the exchange rate changes dramatically! This should not be used for payments that are significantly larger than the path's Maximum Payment Size.

See [`sendSourceAmount`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_sender_.html#sendsourceamount) and [`sendDestinationAmount`](https://emschwartz.github.io/ilp-protocol-psk2/modules/_sender_.html#senddestinationamount).