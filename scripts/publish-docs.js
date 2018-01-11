const ghpages = require('gh-pages')

ghpages.publish('doc', {
  src: '**/*|\.nojekyll',
  message: 'docs: [skip ci] Publish docs',
  user: {
    name: 'CircleCI',
    email: 'none'
  }
}, function (err) {
  if (err) {
    throw err
  }

  console.log('Published docs')
})
