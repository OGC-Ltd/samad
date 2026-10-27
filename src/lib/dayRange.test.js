import { describe, it, expect } from 'vitest';
import { addDays, addMonths, daysBetween, clampRange, joinDays, monthGrid, rangeFromClicks, rangeWords } from './dayRange';

const TODAY = '2026-09-28';
const fmtDay = (k) => `${Number(k.slice(8))} Sep`;

describe('addDays / daysBetween', () => {
  it('crosses a month end', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('is one day when both ends are the same', () => {
    expect(daysBetween(TODAY, TODAY)).toEqual([TODAY]);
  });
});

describe('clampRange', () => {
  it('keeps a single day a single day', () => {
    expect(clampRange('2026-09-20', '2026-09-20', TODAY, 14)).toEqual(['2026-09-20', '2026-09-20']);
  });

  it('pulls To along when From is set past it', () => {
    expect(clampRange('2026-09-25', '2026-09-22', TODAY, 14, 'from')).toEqual(['2026-09-25', '2026-09-25']);
  });

  it('pulls From along when To is set before it', () => {
    expect(clampRange('2026-09-25', '2026-09-22', TODAY, 14, 'to')).toEqual(['2026-09-22', '2026-09-22']);
  });

  it('holds the range to 14 days, giving way at the end not just set', () => {
    expect(clampRange('2026-09-01', TODAY, TODAY, 14, 'from')).toEqual(['2026-09-01', '2026-09-14']);
    expect(clampRange('2026-09-01', TODAY, TODAY, 14, 'to')).toEqual(['2026-09-15', TODAY]);
  });

  it('never runs past today', () => {
    expect(clampRange('2026-09-27', '2026-10-03', TODAY, 14)).toEqual(['2026-09-27', TODAY]);
  });
});

describe('joinDays', () => {
  it('hands one day back as it is', () => {
    const day = [{ t: 1 }, { t: 2 }];
    expect(joinDays([day])).toBe(day);
    expect(joinDays([[], day])).toBe(day);
  });

  it('runs days in time order and drops a reading held by both', () => {
    const got = joinDays([[{ t: 5 }, { t: 9 }], [{ t: 1 }, { t: 3 }, { t: 5 }]]);
    expect(got.map((p) => p.t)).toEqual([1, 3, 5, 9]);
  });

  it('is empty with nothing held', () => {
    expect(joinDays([])).toEqual([]);
  });
});

describe('monthGrid', () => {
  it('lays September 2026 out Monday first', () => {
    const weeks = monthGrid('2026-09');
    // 1 Sep 2026 is a Tuesday
    expect(weeks[0]).toEqual([null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(weeks[weeks.length - 1]).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', null, null, null, null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it('starts a month that begins on a Monday with no gap', () => {
    expect(monthGrid('2026-06')[0][0]).toBe('2026-06-01');
  });
});

describe('addMonths', () => {
  it('crosses a year', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
});

describe('rangeFromClicks', () => {
  it('takes two clicks either way round, and one day twice as that day', () => {
    expect(rangeFromClicks('2026-09-22', '2026-09-26')).toEqual(['2026-09-22', '2026-09-26']);
    expect(rangeFromClicks('2026-09-26', '2026-09-22')).toEqual(['2026-09-22', '2026-09-26']);
    expect(rangeFromClicks('2026-09-24', '2026-09-24')).toEqual(['2026-09-24', '2026-09-24']);
  });
});

describe('rangeWords', () => {
  it('names a day or a range', () => {
    expect(rangeWords(TODAY, TODAY, TODAY, fmtDay)).toBe('today');
    expect(rangeWords('2026-09-27', '2026-09-27', TODAY, fmtDay)).toBe('on 27 Sep');
    expect(rangeWords('2026-09-21', '2026-09-27', TODAY, fmtDay)).toBe('from 21 Sep to 27 Sep');
    expect(rangeWords('2026-09-22', TODAY, TODAY, fmtDay)).toBe('from 22 Sep to today');
  });
});
