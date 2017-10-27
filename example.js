const mocks = require('./mocks')
const crypto = require('crypto')
const BigNumber = require('bignumber.js')
const psk2 = require('.')

const pluginA1 = new mocks.Plugin({
  account: 'test.a.sender',
  prefix: 'test.a.',
  balance: '10000'
})
const pluginA2 = new mocks.Plugin({
  account: 'test.a.connector',
  prefix: 'test.a.',
  balance: '100000000'
})
pluginA1.linkToOtherPlugin(pluginA2)
pluginA2.linkToOtherPlugin(pluginA1)

const pluginB1 = new mocks.Plugin({
  account: 'test.b.receiver',
  prefix: 'test.b.',
  balance: '0'
})
const pluginB2 = new mocks.Plugin({
  account: 'test.b.connector',
  prefix: 'test.b.',
  balance: '1000000'
})
pluginB1.linkToOtherPlugin(pluginB2)
pluginB2.linkToOtherPlugin(pluginB1)

const mps1 = BigNumber.random().shift(3).truncated()
const mps2 = BigNumber.random().shift(3).truncated()
const rate = BigNumber.random().shift(1)
console.log(`rate: ${rate.toString(10)}, mps1: ${mps1.toString(10)}, mps2: ${mps2.toString(10)}`)
const connector = new mocks.Connector({
  plugin1: pluginA2,
  plugin2: pluginB2,
  mps1,
  mps2,
  rate,
  spread: 0.01
})
console.log(connector)

async function main () {
  const receiverSecret = crypto.randomBytes(32)
  psk2.listen(pluginB1, { receiverSecret }, async (incomingPayment) => {
    const amountReceived = await incomingPayment.accept()
    console.log('receiver got:', amountReceived)
  })
  const { destinationAccount, sharedSecret } = psk2.generateParams({
    plugin: pluginB1,
    receiverSecret
  })
  console.log(`generated PSK params: destinationAccount ${destinationAccount}, sharedSecret ${sharedSecret.toString('base64')}`)
  //const destinationAmount = await psk2.quoteBySourceAmount(pluginA1, {}, {
    //destinationAccount,
    //sourceAmount: '10',
    //sharedSecret
  //})
  //console.log('got quote:', destinationAmount)

  const destinationResult = await psk2.sendByDestinationAmount(pluginA1, {}, {
    destinationAccount,
    destinationAmount: '10000',
    sharedSecret
  })
  console.log('sent payment with fixed destination amount:', destinationResult)

  //const sourceResult = await psk2.sendBySourceAmount(pluginA1, {}, {
    //destinationAccount,
    //sourceAmount: '10000',
    //sharedSecret
  //})
  //console.log('sent payment with fixed source amount:', sourceResult)
  process.exit(0)
}
main().catch(err => console.log(err.stack))
