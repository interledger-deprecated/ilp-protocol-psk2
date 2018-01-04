import { EventEmitter } from 'events'
import * as IlpPacket from 'ilp-packet'
import BigNumber from 'bignumber.js'

export interface DataHandler {
  (data: Buffer): Promise<Buffer>
}
export interface MoneyHandler {
  (amount: string): Promise<void>
}

const defaultDataHandler = (data: Buffer) => Promise.resolve(IlpPacket.serializeIlpReject({
  code: 'F02', // Unreachable
  triggeredBy: 'example.mock-plugin',
  message: 'No data handler registered',
  data: Buffer.alloc(0)
}))
const defaultMoneyHandler = (amount: string) => Promise.resolve()

export default class MockPlugin extends EventEmitter {
  static readonly version = 2
  public dataHandler: DataHandler
  public moneyHandler: MoneyHandler
  public exchangeRate: number

  constructor (exchangeRate: number) {
    super()

    this.dataHandler = defaultDataHandler
    this.moneyHandler = defaultMoneyHandler
    this.exchangeRate = exchangeRate
  }

  async connect () {
    return Promise.resolve()
  }

  async disconnect () {
    return Promise.resolve()
  }

  isConnected () {
    return true
  }

  async sendData (data: Buffer): Promise<Buffer> {
    if (data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const parsed = IlpPacket.deserializeIlpPrepare(data)
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
    this.dataHandler = defaultDataHandler
  }

  registerMoneyHandler (handler: MoneyHandler): void {
    this.moneyHandler = handler
  }
}
