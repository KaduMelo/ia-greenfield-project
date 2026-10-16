import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.STORAGE_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
  uploadPartSizeBytes: parseInt(
    process.env.STORAGE_UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS || '21600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.STORAGE_PLAYBACK_URL_TTL_SECONDS || '3600',
    10,
  ),
}));
