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

const sharedSecret = crypto.randomBytes(32)
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

  await PSK2.listen(receiver, {
    secret: sharedSecret
  })

  const quote = await PSK2.quote(sender, {
    destination: 'example.mini.' + tokenToAccount('receiver'),
    sourceAmount: '10',
    sharedSecret
  })
  console.log('got quote:', quote)

  const sendResult = await PSK2.send(sender, {
    destination: 'example.mini.' + tokenToAccount('receiver'),
    sourceAmount: '100',
    sharedSecret
  })
  console.log('sent payment. result:', sendResult)

  const deliverResult = await PSK2.deliver(sender, {
    destination: 'example.mini.' + tokenToAccount('receiver'),
    destinationAmount: '1500',
    sharedSecret
  })
  console.log('sent payment. result:', deliverResult)
}

main().catch((err) => console.log(err))
