const Hapi = require('@hapi/hapi')
const Boom = require('@hapi/boom')
const Bell = require('@hapi/bell')
const Cookie = require('@hapi/cookie')
const levelup = require('levelup')
const leveldown = require('leveldown')
const encode = require('encoding-down')
const cuid = require('cuid')
const Queue = require('bee-queue')

const { populateCache, extractPublicPart } = require('./common')
const config = require('./config')

const votesQueue = new Queue('votes', {
  redis: { db: config.redis.db }
})

const db = levelup(encode(leveldown('./db'), { valueEncoding: 'json' }))
let cache, stats

const internals = {}

internals.start = async function () {
  const server = Hapi.server({
    port: config.port,
    routes: { cors: { credentials: true } },
    state: { isSameSite: false } // required for CORS
  })

  await server.register([Cookie, Bell])

  server.auth.strategy('session', 'cookie', {
    cookie: {
      name: 'fookie',
      password: config.cookiePassword,
      ttl: 30 * 24 * 60 * 60 * 1000, // 1000 days
      path: '/',
      isSameSite: false
    },
    keepAlive: true
  })

  server.auth.strategy('google', 'bell', {
    provider: 'google',
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    password: config.cookiePassword,
    location: config.serviceUrl
  })

  server.auth.strategy('facebook', 'bell', {
    provider: 'facebook',
    clientId: config.facebook.clientId,
    clientSecret: config.facebook.clientSecret,
    password: config.cookiePassword,
    location: config.serviceUrl
  })

  server.route({
    method: 'GET',
    path: '/',
    options: {
      auth: {
        strategy: 'session',
        mode: 'try'
      },
      handler: entrypoint
    }
  })

  server.route({
    method: 'GET',
    path: '/votes/{countryCode}',
    options: {
      handler: listVotes
    }
  })

  server.route({
    method: 'GET',
    path: '/stats',
    options: {
      handler: listStats
    }
  })

  server.route({
    method: 'GET',
    path: '/data',
    options: {
      auth: 'session',
      handler: listData
    }
  })

  server.route({
    method: 'GET',
    path: '/auth/google',
    options: {
      auth: 'google',
      handler: oauth
    }
  })

  server.route({
    method: 'GET',
    path: '/auth/facebook',
    options: {
      auth: 'facebook',
      handler: oauth
    }
  })

  server.route({
    method: 'PUT',
    path: '/{cuid}',
    options: {
      auth: 'session',
      handler: vote
    }
  })

  cache = await populateCache(db.createValueStream())
  stats = createStats(cache)

  await server.start()
}

internals.start()

function createStats (cache) {
  const newStats = {
    global: {
      count: 0
    },
    country: cache.map(country => {
      return {
        code: country.code,
        count: country.vote.length,
        vote: country.vote.slice(0, 5)
      }
    })
  }
  for (const country of cache) {
    newStats.global.count += country.vote.length
  }
  return newStats
}

async function entrypoint (request, h) {
  const info = {
    authProviders: {
      facebook: '/auth/facebook',
      google: '/auth/google'
    }
  }
  if (request.auth.credentials) {
    const email = request.auth.credentials.email
    const vote = await db.get(email)
    // TODO handle if somehow vote doesn't exist
    info.vote = vote
  }
  return info
}

async function oauth (request, h) {
  const email = request.auth.credentials.profile.email
  if (email) {
    let vote
    try {
      vote = await db.get(email)
    } catch (err) {
      vote = {
        id: `${config.serviceUrl}/${cuid()}`,
        email
      }
      await db.put(email, vote)
    }
    request.cookieAuth.set({ email })
  }
  // redirect to app (/voters)
  return h.redirect(`${config.appUrl}/voters`)
}

function getIndex (vote) {
  let country = cache.find(c => c.code === vote.nationality)
  if (!country) {
    country = {
      code: vote.nationality,
      vote: []
    }
    cache.push(country)
  }
  return country.vote.length + 1
}

// PUT
async function vote (request, h) {
  const email = request.auth.credentials.email
  if (request.payload.email !== email) {
    return Boom.forbidden()
  } else {
    // check if vote existis
    let vote = await db.get(email)
    if (request.payload.id !== vote.id || vote.created) {
      // respond with conflict
      return Boom.conflict()
    } else if (request.payload['I accept privacy policy and terms of service'] !== 'on' ||
               request.payload['I am over 18 years old'] !== 'on') {
      // respond with Not Acceptable
      return Boom.notAcceptable()
    } else {
      vote = {
        ...request.payload,
        created: new Date().toISOString(),
        index: getIndex(request.payload)
      }
      try {
        await db.put(email, vote)
        const country = cache.find(c => c.code === vote.nationality)
        country.vote = [extractPublicPart(vote), ...country.vote]
        cache.sort((a, b) => b.vote.length - a.vote.length)
        stats = createStats(cache)
      } catch (err) {
        console.log(err)
      }
      // create delayed job
      try {
        await votesQueue.createJob(vote).save()
      } catch (err) {
        console.log(err)
      }
      // respond with 204
      return null
    }
  }
}

async function listData (request, h) {
  const email = request.auth.credentials.email
  if (email !== config.admin) {
    return Boom.forbidden()
  } else {
    const list = []
    for await (const vote of db.createValueStream()) {
      list.push(vote)
    }
    return list
  }
}

async function listVotes (request, h) {
  return cache.find(c => c.code === request.params.countryCode)
}

async function listStats (request, h) {
  return stats
}

process.on('unhandledRejection', (err) => {
  console.log(err)
  process.exit(1)
})
