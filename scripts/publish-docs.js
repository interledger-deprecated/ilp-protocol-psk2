const ghpages = require('ghpages')

ghpages.publish('doc', {
  message: '[skip ci] Publish docs',
  user: {
    name: 'CircleCI',
    email: 'none'
  }
})
