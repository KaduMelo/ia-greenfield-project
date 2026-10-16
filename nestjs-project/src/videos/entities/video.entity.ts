import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/** Processing lifecycle (phase-03-videos/TD-12 + Revision 2026-10-15). */
export enum VideoStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}

/** Publication dimension, kept apart from processing; `published` arrives in Phase 04. */
export enum VideoPublicationStatus {
  DRAFT = 'draft',
}

export const MAX_VIDEO_SIZE_BYTES = 10737418240; // 10GB (phase-03-videos/TD-05)

/** `numeric` comes back from `pg` as a string; expose it as a number. */
const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Check(
  'CHK_videos_declared_size_bytes',
  `"declared_size_bytes" > 0 AND "declared_size_bytes" <= ${MAX_VIDEO_SIZE_BYTES}`,
)
@Index('IDX_videos_status_updated_at', ['status', 'updated_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  /** `bigint` is read by `pg` as a string; services convert to number. */
  @Column({ type: 'bigint' })
  declared_size_bytes: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.UPLOADING,
  })
  status: VideoStatus;

  @Column({
    type: 'enum',
    enum: VideoPublicationStatus,
    enumName: 'video_publication_status',
    default: VideoPublicationStatus.DRAFT,
  })
  publication_status: VideoPublicationStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  processing_error: string | null;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', length: 255 })
  source_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  format_name: string | null;

  @Column({ type: 'jsonb', nullable: true })
  probe_metadata: Record<string, any> | null;

  @Column({ type: 'timestamptz', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
