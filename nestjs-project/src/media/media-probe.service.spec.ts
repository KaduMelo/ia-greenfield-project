import { NoVideoStreamError, parseProbeOutput } from './media-probe.service';

describe('parseProbeOutput', () => {
  const ffprobeJson = {
    streams: [
      { codec_type: 'audio', duration: '2.000000' },
      { codec_type: 'video', width: 320, height: 240, duration: '2.000000' },
    ],
    format: { duration: '2.040000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
  };

  it('should map duration, dimensions and format from the video stream and format', () => {
    const result = parseProbeOutput(JSON.stringify(ffprobeJson));

    expect(result).toMatchObject({
      durationSeconds: 2.04,
      width: 320,
      height: 240,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
    expect(result.raw).toEqual(ffprobeJson);
  });

  it('should fall back to the video stream duration when the format has none', () => {
    const result = parseProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: 'video', width: 10, height: 10, duration: '1.5' },
        ],
        format: { format_name: 'webm' },
      }),
    );

    expect(result.durationSeconds).toBe(1.5);
  });

  it('should throw NoVideoStreamError when there is no video stream', () => {
    const audioOnly = {
      streams: [{ codec_type: 'audio', duration: '2.0' }],
      format: { duration: '2.0', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
    };

    expect(() => parseProbeOutput(JSON.stringify(audioOnly))).toThrow(
      NoVideoStreamError,
    );
  });

  it('should throw NoVideoStreamError when ffprobe reports no streams at all', () => {
    expect(() => parseProbeOutput(JSON.stringify({ format: {} }))).toThrow(
      NoVideoStreamError,
    );
  });
});
