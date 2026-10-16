import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PlaybackUrlResponseDto } from './dto/playback-url-response.dto';
import { VideoPublicIdParam } from './dto/video-public-id.param';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and starts a multipart upload directly to the object storage. Returns one presigned PUT URL per part; the bytes never pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload started',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed (content type not allowed, size above 10GB, …)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createUpload(user.sub, dto);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload with the parts sent to the storage, verifies the real size against the declared one and moves the video to processing, enqueuing the processing job.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Video id returned by POST /videos',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; video is processing',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or id is not a uuid',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the caller channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not uploading (INVALID_VIDEO_STATE)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'Storage rejected the parts (UPLOAD_COMPLETION_FAILED) or the real size differs from the declared one (UPLOAD_SIZE_MISMATCH)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, id, dto.parts);
  }

  @Get(':publicId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a video by its unique URL id',
    description:
      'Returns the video of the caller channel identified by its public id, including the processing status, extracted metadata and a presigned thumbnail URL.',
  })
  @ApiParam({
    name: 'publicId',
    description: 'Unique public id (11 base62 characters)',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'publicId is not 11 base62 characters',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the caller channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParam,
  ): Promise<VideoResponseDto> {
    return this.videosService.getVideo(user.sub, params.publicId);
  }

  @Get(':publicId/stream')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a short-lived presigned GET URL for playback. The object storage serves Range requests with 206 Partial Content, so playback starts without downloading the whole file.',
  })
  @ApiParam({
    name: 'publicId',
    description: 'Unique public id (11 base62 characters)',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    type: PlaybackUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'publicId is not 11 base62 characters',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the caller channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video processing has not finished (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParam,
  ): Promise<PlaybackUrlResponseDto> {
    return this.videosService.getPlaybackUrl(
      user.sub,
      params.publicId,
      'stream',
    );
  }

  @Get(':publicId/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a short-lived presigned GET URL that serves the original file as an attachment (Content-Disposition: attachment).',
  })
  @ApiParam({
    name: 'publicId',
    description: 'Unique public id (11 base62 characters)',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: PlaybackUrlResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'publicId is not 11 base62 characters',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found in the caller channel (VIDEO_NOT_FOUND)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video processing has not finished (VIDEO_NOT_READY)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param() params: VideoPublicIdParam,
  ): Promise<PlaybackUrlResponseDto> {
    return this.videosService.getPlaybackUrl(
      user.sub,
      params.publicId,
      'download',
    );
  }
}
