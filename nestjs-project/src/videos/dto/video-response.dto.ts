import { ApiProperty } from '@nestjs/swagger';
import { VideoPublicationStatus, VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kQ9xLm2P', pattern: '^[0-9A-Za-z]{11}$' })
  publicId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ enum: VideoPublicationStatus })
  publicationStatus: VideoPublicationStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  processingError: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 2.0 })
  durationSeconds: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ type: 'integer', nullable: true })
  sizeBytes: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  formatName: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Presigned GET URL of the thumbnail; null until processed',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  processedAt: string | null;
}
