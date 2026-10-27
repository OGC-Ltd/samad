import { describe, it, expect } from 'vitest';
import { settleLimited } from './settleLimited';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('settleLimited', () => {
  it('never runs more than the limit at once', async () => {
    let running = 0, most = 0;
    await settleLimited([...Array(20).keys()], 4, async () => {
      running++; most = Math.max(most, running);
      await tick();
      running--;
    });
    expect(most).toBe(4);
  });

  it('keeps the order, and settles each one like Promise.allSettled', async () => {
    const rs = await settleLimited([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      if (n === 1) throw new Error('one');
      return n * 10;
    });
    expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(rs[0].value).toBe(30);
    expect(rs[1].reason.message).toBe('one');
    expect(rs[2].value).toBe(20);
  });

  it('handles an empty list', async () => {
    expect(await settleLimited([], 4, async () => 1)).toEqual([]);
  });
});
