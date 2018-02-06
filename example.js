const crypto = require('crypto')
const IlpPluginBtp = require('ilp-plugin-btp')
const PSK2 = require('.') 

;(async () => {
  const receiverPlugin =  new IlpPluginBtp({ 
    server: `btp+wss://:${crypto.randomBytes(16).toString('hex')}@amundsen.ilpdemo.org:1801`
  })
  const receiver = await PSK2.createReceiver({
    plugin: receiverPlugin,
    requestHandler: async (params) => {
      params.accept(Buffer.from('thanks!'))
      console.log(`Receiver got paid request with ${params.amount} attached and data: ${params.data.toString('utf8')}`)
      receiver.close()
    }
  })
  console.log('Receiver listening')

  // These would normally be passed through some application layer protcol
  const { destinationAccount, sharedSecret } = receiver.generateAddressAndSecret()
  console.log(`Using destinationAccount: ${destinationAccount} and sharedSecret: ${sharedSecret.toString('hex')}`)

  const senderPlugin = new IlpPluginBtp({ 
    server: `btp+wss://:${crypto.randomBytes(16).toString('hex')}@amundsen.ilpdemo.org:1801`
  })
  await senderPlugin.connect()

  // Get a quote using an unfulfillable request
  console.log('Getting a quote using an unfulfillable request')
  const sourceAmount = '100'
  const { destinationAmount } = await PSK2.sendRequest(senderPlugin, {
    destinationAccount,
    sharedSecret,
    sourceAmount,
    unfulfillableCondition: crypto.randomBytes(32)
  })
  console.log(`Path exchange rate is: ${destinationAmount.dividedBy(sourceAmount)}`)

  console.log('Sending a real paid request now')
  const result = await PSK2.sendRequest(senderPlugin, {
    destinationAccount,
    sharedSecret,
    sourceAmount,
    minDestinationAmount: '98',
    data: Buffer.from('here is some money!', 'utf8')
  })
  console.log(`Sent payment of ${sourceAmount}, receiver got ${result.destinationAmount} and responded with message: ${result.data.toString('utf8')}`)

  process.exit(0)
})().catch(err => console.log(err))
