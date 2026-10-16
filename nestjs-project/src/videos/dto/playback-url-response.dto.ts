import { ApiProperty } from '@nestjs/swagger';

export class PlaybackUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived presigned GET URL; the storage serves Range / 206 Partial Content',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
