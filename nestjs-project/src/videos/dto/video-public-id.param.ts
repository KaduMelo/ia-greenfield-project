import { Matches } from 'class-validator';
import { PUBLIC_ID_PATTERN } from '../public-id.util';

export class VideoPublicIdParam {
  /** Unique public id of the video (11 base62 characters). */
  @Matches(PUBLIC_ID_PATTERN)
  publicId: string;
}
