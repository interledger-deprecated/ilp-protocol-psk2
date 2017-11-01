# (Prototype of) PSKv2

**This is a work in progress. The protocol and implementation are under heavy development and not ready for real use.**

This is a prototype of a V2 for the ILP Pre-Shared Key Transport Protocol.

## (Intended) Features

- **Chunked Payments** - Splitting and reassembling larger payments
- **End-to-end Quoting** - Alternative to ILQP that uses test payments to determine exchange rates
- **Encrypted amount** - Includes amount in the encrypted data instead of in plaintext packet to avoid connectors skimming amount off the top

## Key Differences from PSK 1.0

- Handles path Maximum Payment Size
- Does not rely on ILQP
- Does not use amount field in ILP packet (uses encrypted data instead)
- No public headers, all data is encrypted

## Roadmap

## Chunked Payments

- [x] Basic chunked payment by destination amount
- [x] Basic chunked payment by source amount
- [x] Receiver sends refunds for chunked payments that time out
- [x] Handle T04 Insufficient Liquidity errors
- [x] Sender listens for refund payment
- [x] Timeout before refund issued adjusts based on expected payment time
- [x] Sender accepts partial refunds but knows exactly how much they lost on chunked payment that fails
- [x] Handle other final errors
- [ ] Track amount refunded on incoming and outgoing payments
- [ ] Receiver should be smart about when to assume the payment is over and initiate a refund
- [ ] Try to hit destination amount exactly when delivering
- [ ] Handle fluctuating exchange rate
- [ ] Workarounds if connectors don't support fulfillment data (as discussed in [RFCs issue #314](https://github.com/interledger/rfcs/issues/314))
- [ ] Sending payment chunks through multiple connectors
- [ ] Multiple payments in flight (if that's useful)
- [ ] Persistence for payment details in case process crashes
- [ ] Finalize serialization format for headers + data
- [ ] Minimize redundancy of payment data
- [ ] Carry application data (split over payment chunks?)

### E2E Quoting

- [x] E2E quote by source amount
- [ ] E2E quote by destination amount
- [ ] Standalone function for discovering path Maximum Payment Size

## Encrypted Amount

- [ ] Encrypt data
- [ ] Non-chunked payments with encrypted destination amount
