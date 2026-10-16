import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'aZ3kQ9xLm2P', pattern: '^[0-9A-Za-z]{11}$' })
  publicId: string;

  @ApiProperty({ enum: [VideoStatus.PROCESSING] })
  status: VideoStatus;
}
