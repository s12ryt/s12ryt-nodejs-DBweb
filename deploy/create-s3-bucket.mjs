import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire('/app/api/package.json')
const { CreateBucketCommand, S3Client } = require('@aws-sdk/client-s3')

const client = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.DBWEB_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.DBWEB_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.DBWEB_S3_SECRET_ACCESS_KEY,
  },
})

try {
  await client.send(new CreateBucketCommand({ Bucket: 'dbweb-transfers' }))
} catch (error) {
  if (error?.name !== 'BucketAlreadyOwnedByYou' && error?.name !== 'BucketAlreadyExists') throw error
} finally {
  client.destroy()
}
