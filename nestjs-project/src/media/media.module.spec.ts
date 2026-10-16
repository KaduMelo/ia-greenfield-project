import { Test } from '@nestjs/testing';
import { MediaProbeService } from './media-probe.service';
import { MediaModule } from './media.module';

describe('MediaModule', () => {
  it('should compile and export MediaProbeService', async () => {
    const module = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();

    expect(module.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);
    await module.close();
  });
});
