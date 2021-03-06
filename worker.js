const Queue = require('bee-queue')
const nodemailer = require('nodemailer')
const fetch = require('node-fetch')

const { doneEmailText, confirmEmailText } = require('./emailText')
const config = require('./config')

const votesQueue = new Queue('votes', {
  redis: { db: config.redis.db }
})
const mailTransporter = nodemailer.createTransport(config.smtp)

votesQueue.on('ready', () => {
  votesQueue.process(async (job) => {
    // send email
    try {
      await mailTransporter.sendMail(generateMail(job.data))
    } catch (err) {
      console.log(err)
    }
    // backup vote
    if (config.backup.url && config.backup.token && job.data.confirmed) {
      try {
        await fetch(config.backup.url, {
          method: 'POST',
          body: JSON.stringify(job.data),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.backup.token}`
          }
        })
      } catch (err) {
        console.log(err)
      }
    }
  })
})

function generateMail (vote) {
  const email = {
    from: `"Alice in Government" <${config.smtp.auth.user}>`,
    to: vote.email
  }
  if (vote.confirmed) {
    email.subject = 'Your vote was registered successfully'
    email.text = doneEmailText(vote)
  } else {
    email.subject = 'Please confirm your vote'
    email.text = confirmEmailText(vote)
  }
  return email
}
