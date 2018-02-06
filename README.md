# PSKv2
> Javascript implementation of the [Pre-Shared Key V2](https://github.com/interledger/rfcs/blob/master/0025-pre-shared-key-2/0025-pre-shared-key-2.md) Interledger Transport Protocol.

[![CircleCI](https://circleci.com/gh/interledgerjs/ilp-protocol-psk2.svg?style=shield)](https://circleci.com/gh/interledgerjs/ilp-protocol-psk2)
[![codecov](https://codecov.io/gh/interledgerjs/ilp-protocol-psk2/branch/master/graph/badge.svg)](https://codecov.io/gh/interledgerjs/ilp-protocol-psk2)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

PSK2 is a request/response protocol built on ILP that can send value and/or data. It handles generating conditions and fulfillments for ILP Prepare/Fulfill packets to send value, and it encrypts and authenticates request and response data.

PSK2 can be used to send indivdiual payment chunks, unfulfillable test payments for quotes, and it can be used as part of a protocol/module for streaming or chunked payments.

## Installation

```shell
npm install ilp-protocol-psk2
```

## API Documentation

See https://interledgerjs.github.io/ilp-protocol-psk2

## Usage

### Creating a Receiver

Uses [`createReceiver`](https://interledgerjs.github.io/ilp-protocol-psk2/modules/_receiver_.html#createreceiver) and [`Receiver.generateAddressAndSecret`](https://interledgerjs.github.io/ilp-protocol-psk2/classes/_receiver_.receiver.html#generateaddressandsecret).

```js
const { createReceive } = require('ilp-protocol-psk2')
const receiver = await createReceiver({
  plugin: myLedgerPlugin,
  requestHandler: (params) => {
    // Fulfill the incoming request
    // Note the data format and encoding is up to the application protocol / module
    params.accept(Buffer.from('thanks for the payment!'))
    console.log(`Got paid: ${params.amount} and got this data: ${params.data.toString()}`)
  }
})

const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()
// Give these two values to a sender to enable them to send payments to this Receiver
```

### Sending a Request

Uses [`sendRequest`](https://interledgerjs.github.io/ilp-protocol-psk2/modules/_sender_.html#sendrequest).

```js
const { sendRequest } = require('ilp-protocol-psk2')

// These values must be communicated beforehand for the sender to send a payment
const { destinationAccount, sharedSecret } = await getAddressAndSecretFromReceiver()

const { fulfilled, destinationAmount, data } = await sendRequest(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  sourceAmount: '1000',
  minDestinationAmount: '500',
  data: Buffer.from('here you go!')
})
if (fulfilled) {
  console.log(`Sent request with 1000 units of value attached, receiver got ${destinationAmount} and responded with the message: ${data.toString('utf8')}`)
  // Note the data format and encoding is up to the application protocol / module
}
```

### Sending an Unfulfillable Request or Quote

Uses [`sendRequest`](https://interledgerjs.github.io/ilp-protocol-psk2/modules/_sender_.html#sendrequest).

```js
const { sendRequest } = require('ilp-protocol-psk2')
const { randomBytes } = require('crypto')

// These values must be communicated beforehand for the sender to send a payment
const { destinationAccount, sharedSecret } = await getAddressAndSecretFromReceiver()

const { destinationAmount } = await sendRequest(myLedgerPlugin, {
  destinationAccount,
  sharedSecret,
  sourceAmount: '1000',
  unfulfillableCondition: randomBytes(32)
})
console.log(`Path exchange rate is: ${destinationAmount.dividedBy(1000)}`
```
