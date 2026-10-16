import { ApiProperty } from '@nestjs/swagger';
import { VideoPublicationStatus, VideoStatus } from '../entities/video.entity';

export class PresignedPartDto {
  @ApiProperty({ type: 'integer', example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned PUT URL for this part' })
  url: string;
}

export class CreateVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kQ9xLm2P', pattern: '^[0-9A-Za-z]{11}$' })
  publicId: string;

  @ApiProperty({ enum: [VideoStatus.UPLOADING] })
  status: VideoStatus;

  @ApiProperty({ enum: VideoPublicationStatus })
  publicationStatus: VideoPublicationStatus;

  @ApiProperty({ description: 'Multipart UploadId at the object storage' })
  uploadId: string;

  @ApiProperty({
    type: 'integer',
    description: 'Size of every part in bytes; the last part may be smaller',
    example: 67108864,
  })
  partSize: number;

  @ApiProperty({ type: [PresignedPartDto] })
  parts: PresignedPartDto[];

  @ApiProperty({
    format: 'date-time',
    description: 'When the part URLs expire',
  })
  expiresAt: string;
}
