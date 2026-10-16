import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export const TEST_BUCKETS = {
  videos: 'streamtube-videos-test',
  thumbnails: 'streamtube-thumbnails-test',
} as const;

/**
 * Points the storage config at the dedicated test buckets. Must run before
 * the Nest testing module is compiled, because `registerAs` factories read
 * `process.env` when the ConfigModule loads them.
 */
export function useTestStorageBuckets(): void {
  process.env.STORAGE_VIDEOS_BUCKET = TEST_BUCKETS.videos;
  process.env.STORAGE_THUMBNAILS_BUCKET = TEST_BUCKETS.thumbnails;
}

export function createTestS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY!,
      secretAccessKey: process.env.STORAGE_SECRET_KEY!,
    },
  });
}

/** Deletes every object and aborts every pending multipart upload in the test buckets. */
export async function clearTestBuckets(client: S3Client): Promise<void> {
  for (const bucket of Object.values(TEST_BUCKETS)) {
    const { Contents = [] } = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    for (const object of Contents) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
    }

    const { Uploads = [] } = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    for (const upload of Uploads) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
    }
  }
}
