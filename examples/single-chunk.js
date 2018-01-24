const crypto = require('crypto')
const base64url = require('base64url')
const IlpPluginBtp = require('ilp-plugin-btp') // to be used by receiver
const IlpPluginHttpOer = require('ilp-plugin-http-oer') // to be used by sender
const { createReceiver, sendSingleChunk, quoteDestinationAmount } = require('..')

let destinationAccount
let sharedSecret

async function getAddressAndSecretFromReceiver() {
  const receiverToken = base64url(crypto.randomBytes(32))
  const receiver = await createReceiver({
    plugin: new IlpPluginBtp({ server: `btp+wss://:${receiverToken}@amundsen.ilpdemo.org:1801` }),
    paymentHandler: async (params) => {
      // Accept all incoming payments
      const result = await params.accept()
      console.log('Got payment for:', result.receivedAmount)
    }
  })

  return receiver.generateAddressAndSecret()
  // Give these two values to a sender to enable them to send payments to this Receiver
}


;(async () => {
  const myLedgerPlugin = new IlpPluginHttpOer({ peerUrl: `https://amundsen.ilpdemo.org:1801/` })
  await myLedgerPlugin.connect()

  // These values must be communicated beforehand for the sender to send a payment
  const { destinationAccount, sharedSecret } = await getAddressAndSecretFromReceiver()
  console.log( { destinationAccount, sharedSecret } )

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
})().catch(err => console.log(err))
