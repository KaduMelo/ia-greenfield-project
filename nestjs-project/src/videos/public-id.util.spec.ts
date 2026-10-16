import {
  generatePublicId,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PATTERN,
} from './public-id.util';

describe('generatePublicId', () => {
  it('should return an 11-character base62 id', () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(PUBLIC_ID_PATTERN);
  });

  it('should not collide across 10,000 samples', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
  });

  it('should only use characters from the base62 alphabet', () => {
    const chars = new Set(
      Array.from({ length: 2_000 }, generatePublicId).join(''),
    );

    for (const char of chars) {
      expect(char).toMatch(/^[0-9A-Za-z]$/);
    }
    // With 22k uniformly drawn characters every symbol should appear.
    expect(chars.size).toBe(62);
  });
});
