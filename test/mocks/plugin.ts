import { EventEmitter } from 'events'
import * as IlpPacket from 'ilp-packet'
import BigNumber from 'bignumber.js'
import * as ILDCP from 'ilp-protocol-ildcp'

export interface DataHandler {
  (data: Buffer): Promise<Buffer>
}
export interface MoneyHandler {
  (amount: string): Promise<void>
}


export default class MockPlugin extends EventEmitter {
  static readonly version = 2
  public dataHandler: DataHandler
  public moneyHandler: MoneyHandler
  public exchangeRate: number
  public connected: boolean

  constructor (exchangeRate: number) {
    super()

    this.dataHandler = this.defaultDataHandler
    this.moneyHandler = this.defaultMoneyHandler
    this.exchangeRate = exchangeRate
  }

  async connect () {
    this.connected = true
    return Promise.resolve()
  }

  async disconnect () {
    this.connected = false
    return Promise.resolve()
  }

  isConnected () {
    return this.connected
  }

  async sendData (data: Buffer): Promise<Buffer> {
    if (data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const parsed = IlpPacket.deserializeIlpPrepare(data)
      if (parsed.destination === 'peer.config') {
        return ILDCP.serializeIldcpResponse({
          clientAddress: 'test.receiver',
          assetScale: 9,
          assetCode: 'ABC'
        })
      }
      const newPacket = IlpPacket.serializeIlpPrepare({
        ...parsed,
        amount: new BigNumber(parsed.amount).times(this.exchangeRate).toString(10)
      })
      return this.dataHandler(newPacket)
    } else {
      return this.dataHandler(data)
    }
  }

  async sendMoney (amount: string): Promise<void> {
    return this.moneyHandler(amount)
  }

  registerDataHandler (handler: DataHandler): void {
    this.dataHandler = handler
  }

  deregisterDataHandler (): void {
    this.dataHandler = this.defaultDataHandler
  }

  registerMoneyHandler (handler: MoneyHandler): void {
    this.moneyHandler = handler
  }

  deregisterMoneyHandler (): void {
    this.moneyHandler = this.defaultMoneyHandler
  }

  async defaultDataHandler (data: Buffer): Promise<Buffer> {
    return IlpPacket.serializeIlpReject({
      code: 'F02', // Unreachable
      triggeredBy: 'example.mock-plugin',
      message: 'No data handler registered',
      data: Buffer.alloc(0)
    })
  }

  async defaultMoneyHandler (amount: string): Promise<void> {
    return
  }
}
