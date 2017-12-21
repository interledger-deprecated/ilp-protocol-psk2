'use strict'

const BigNumber = require('bignumber.js')

// PSK Packet Types
exports.TYPE_CHUNK = 0
exports.TYPE_LAST_CHUNK = 1
exports.TYPE_FULFILLMENT = 2
exports.TYPE_ERROR = 3

// PSK Parameters
exports.PSK_FULFILLMENT_STRING = 'ilp_psk2_fulfillment'
exports.PSK_ENCRYPTION_STRING = 'ilp_psk2_encryption'
exports.ENCRYPTION_ALGORITHM = 'aes-256-gcm'
exports.IV_LENGTH = 12
exports.AUTH_TAG_LENGTH = 16

// Integers
exports.MAX_UINT8 = 255
exports.MAX_UINT32 = 4294967295
exports.MAX_UINT64 = new BigNumber('18446744073709551615')

