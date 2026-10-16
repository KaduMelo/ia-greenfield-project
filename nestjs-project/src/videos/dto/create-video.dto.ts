import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../entities/video.entity';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  VIDEO_FILENAME_MAX_LENGTH,
  VIDEO_TITLE_MAX_LENGTH,
} from '../videos.constants';

export class CreateVideoDto {
  /** Video title (trimmed). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title: string;

  /** Original file name; used in the download `Content-Disposition`. */
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_FILENAME_MAX_LENGTH)
  fileName: string;

  /** Declared MIME type; must be one of the accepted video types. */
  @IsIn(ALLOWED_VIDEO_CONTENT_TYPES)
  contentType: (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

  /** File size in bytes (max 10GB). */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  fileSize: number;
}
