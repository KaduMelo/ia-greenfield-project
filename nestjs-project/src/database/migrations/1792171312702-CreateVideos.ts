import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1792171312702 implements MigrationInterface {
  name = 'CreateVideos1792171312702';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_status" AS ENUM('uploading', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."video_publication_status" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channel_id" uuid NOT NULL, "public_id" character varying(11) NOT NULL, "title" character varying(100) NOT NULL, "original_filename" character varying(255) NOT NULL, "content_type" character varying(100) NOT NULL, "declared_size_bytes" bigint NOT NULL, "status" "public"."video_status" NOT NULL DEFAULT 'uploading', "publication_status" "public"."video_publication_status" NOT NULL DEFAULT 'draft', "processing_error" character varying(255), "upload_id" text, "source_key" character varying(255) NOT NULL, "thumbnail_key" character varying(255), "duration_seconds" numeric(10,3), "width" integer, "height" integer, "size_bytes" bigint, "format_name" character varying(100), "probe_metadata" jsonb, "processed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "CHK_videos_declared_size_bytes" CHECK ("declared_size_bytes" > 0 AND "declared_size_bytes" <= 10737418240), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_status_updated_at" ON "videos" ("status", "updated_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_videos_status_updated_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_publication_status"`);
    await queryRunner.query(`DROP TYPE "public"."video_status"`);
  }
}
