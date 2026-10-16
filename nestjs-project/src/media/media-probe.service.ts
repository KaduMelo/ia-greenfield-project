import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  PROBE_TIMEOUT_MS,
  THUMBNAIL_TIMEOUT_MS,
} from './media.constants';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  formatName: string;
  /** Raw `ffprobe -show_format -show_streams` JSON, persisted as-is. */
  raw: Record<string, any>;
}

/** The input has no video stream (e.g. audio-only file declared as video). */
export class NoVideoStreamError extends Error {
  constructor() {
    super('Input has no video stream');
    this.name = 'NoVideoStreamError';
  }
}

export class MediaCommandError extends Error {
  constructor(command: string, detail: string) {
    super(`${command} failed: ${detail}`);
    this.name = 'MediaCommandError';
  }
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

/** Pure mapping of `ffprobe -print_format json` output (phase-03-videos/TD-08). */
export function parseProbeOutput(stdout: string): ProbeResult {
  const raw = JSON.parse(stdout) as FfprobeOutput;
  const video = raw.streams?.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new NoVideoStreamError();
  }

  const duration = Number(raw.format?.duration ?? video.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    formatName: raw.format?.format_name ?? '',
    raw: raw as Record<string, any>,
  };
}

/**
 * Thin wrapper over the system `ffprobe`/`ffmpeg` binaries (phase-03-videos/TD-08).
 * `input` may be a local path or a presigned GET URL — ffmpeg then reads only
 * the byte ranges it needs, with no scratch disk (phase-03-videos/TD-09).
 */
@Injectable()
export class MediaProbeService {
  async probe(input: string): Promise<ProbeResult> {
    const stdout = await this.run(
      FFPROBE_BIN,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        input,
      ],
      PROBE_TIMEOUT_MS,
    );
    return parseProbeOutput(stdout.toString('utf8'));
  }

  async extractThumbnail(input: string, atSeconds: number): Promise<Buffer> {
    const jpeg = await this.run(
      FFMPEG_BIN,
      [
        '-v',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        input,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
    if (jpeg.length === 0) {
      throw new MediaCommandError(FFMPEG_BIN, 'no frame was extracted');
    }
    return jpeg;
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new MediaCommandError(command, err.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new MediaCommandError(command, `timed out after ${timeoutMs}ms`),
          );
        } else if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(new MediaCommandError(command, `exit ${code}: ${detail}`));
        } else {
          resolve(Buffer.concat(stdout));
        }
      });
    });
  }
}
