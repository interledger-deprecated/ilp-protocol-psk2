'use strict'

const PSK2 = require('.')
const crypto = require('crypto')
const PluginVirtual = require('ilp-plugin-payment-channel-framework')

function tokenToAccount (token) {
  return base64url(crypto.createHash('sha256').update(token).digest('sha256'))
}

function base64url (buf) {
  return Buffer.from(buf, 'base64')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

const receiverSecret = crypto.randomBytes(32)
const sender = new PluginVirtual({
  server: 'btp+ws://:sender@localhost:3002',
})
const receiver = new PluginVirtual({
  server: 'btp+ws://:receiver@localhost:3002',
})

console.log('sender account:', tokenToAccount('sender'))
console.log('receiver account:', tokenToAccount('receiver'))

async function main () {
  await sender.connect()
  await receiver.connect()

  const { destinationAccount, sharedSecret } = PSK2.generateParams({
    destinationAccount: 'example.mini.' + tokenToAccount('receiver'),
    receiverSecret
  })

  const stopListening = PSK2.listen(receiver, {
    receiverSecret
  }, async ({ paymentId, expectedAmount, accept, reject }) => {
    console.log(`receiver accepting payment: ${paymentId} with expected amount: ${expectedAmount}`)
    const result = await accept()
    console.log('receiver got payment', result)
  })

  const quote = await PSK2.quote(sender, {
    destinationAccount,
    sourceAmount: '10',
    sharedSecret
  })
  console.log('got quote:', quote)

  const singleChunkResult = await PSK2.sendSingleChunk(sender, {
    destinationAccount,
    sourceAmount: '10',
    sharedSecret
  })
  console.log('sent single chunk payment. result:', singleChunkResult)

  const sendResult = await PSK2.send(sender, {
    destinationAccount,
    sourceAmount: '100',
    sharedSecret
  })
  console.log('sent payment. result:', sendResult)

  const deliverResult = await PSK2.deliver(sender, {
    destinationAccount,
    destinationAmount: '1500',
    sharedSecret
  })
  console.log('sent payment. result:', deliverResult)

  stopListening()
}

main().catch((err) => console.log(err))
