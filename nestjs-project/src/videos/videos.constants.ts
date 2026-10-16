/** Content types accepted at upload start; re-checked by ffprobe in the worker (phase-03-videos/TD-05). */
export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

export const VIDEO_TITLE_MAX_LENGTH = 100;
export const VIDEO_FILENAME_MAX_LENGTH = 255;
export const MAX_UPLOAD_PARTS = 10000;
export const PUBLIC_ID_MAX_ATTEMPTS = 3;

/** Object keys inside the videos/thumbnails buckets (phase-03-videos/TD-02). */
export const VIDEO_OBJECT_KEYS = {
  source: (videoId: string): string => `${videoId}/source`,
  thumbnail: (videoId: string): string => `${videoId}/default.jpg`,
} as const;
