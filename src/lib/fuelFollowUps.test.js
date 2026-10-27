import { describe, it, expect } from 'vitest';
import { feedItemFollowUp, followUpAbilities, followUpStage, needsMe } from './fuelFollowUps.js';

const fu = (status, viewer = {}, extra = {}) => ({
  status, ...extra,
  viewer: { deletedIt: false, ownsIt: false, assignedToMe: false, declinedIt: false, canAssign: false, ...viewer },
});

describe('followUpAbilities', () => {
  it('lets a case holder accept or decline a waiting follow-up', () => {
    expect(followUpAbilities(fu('OPEN'), true)).toMatchObject({ accept: true, decline: true, act: false });
  });

  it('keeps an assigned follow-up for its assignee', () => {
    const assigned = (viewer) => fu('OPEN', viewer, { assignedTo: { fullName: 'Tess' } });
    expect(followUpAbilities(assigned({}), true)).toMatchObject({ accept: false, decline: false, why: 'assigned-elsewhere' });
    expect(followUpAbilities(assigned({ assignedToMe: true }), true)).toMatchObject({ accept: true, decline: true });
  });

  it('does not offer a second decline', () => {
    expect(followUpAbilities(fu('OPEN', { declinedIt: true }), true)).toMatchObject({ accept: true, decline: false });
  });

  it('lets an administrator recall one only while somebody holds it', () => {
    expect(followUpAbilities(fu('OPEN', { canAssign: true }), true)).toMatchObject({ recall: false });
    expect(followUpAbilities(fu('OPEN', { canAssign: true }, { assignedTo: { fullName: 'Tess' } }), true)).toMatchObject({ recall: true });
    expect(followUpAbilities(fu('ACCEPTED', { canAssign: true }), true)).toMatchObject({ recall: true });
    expect(followUpAbilities(fu('ACCEPTED'), true)).toMatchObject({ recall: false });
    expect(followUpAbilities(fu('ESCALATED', { canAssign: true }), true)).toMatchObject({ recall: false });
  });

  it('lets an administrator assign anything still open or under review', () => {
    expect(followUpAbilities(fu('OPEN', { canAssign: true, deletedIt: true }), true)).toMatchObject({ assign: true, accept: false });
    expect(followUpAbilities(fu('ACCEPTED', { canAssign: true }), true)).toMatchObject({ assign: true });
    expect(followUpAbilities(fu('ESCALATED', { canAssign: true }), true)).toMatchObject({ assign: false });
  });

  it('never lets the account that deleted the alert accept it', () => {
    expect(followUpAbilities(fu('OPEN', { deletedIt: true }), true)).toMatchObject({ accept: false, why: 'deleted-it' });
  });

  it('gives the decision only to the account that accepted it', () => {
    expect(followUpAbilities(fu('ACCEPTED', { ownsIt: true }), true)).toMatchObject({ act: true });
    expect(followUpAbilities(fu('ACCEPTED'), true)).toMatchObject({ act: false, why: 'someone-else' });
  });

  it('offers nothing without case rights, or once decided', () => {
    expect(followUpAbilities(fu('OPEN'), false)).toMatchObject({ accept: false, act: false, why: 'no-rights' });
    expect(followUpAbilities(fu('ESCALATED', { ownsIt: true }), true)).toMatchObject({ act: false, why: 'closed' });
  });
});

describe('feedItemFollowUp', () => {
  it('reads the follow-up from a live item', () => {
    expect(feedItemFollowUp({ id: 'fu-abc-opened', followUpId: 'abc' })).toBe('abc');
  });

  it('recovers it from the feed id of an item read back from history', () => {
    expect(feedItemFollowUp({ id: 'fu-cmf1x2-escalated' })).toBe('cmf1x2');
    expect(feedItemFollowUp({ id: 'fu-cmf1x2-deescalated' })).toBe('cmf1x2');
    expect(feedItemFollowUp({ id: 'fu-cmf1x2-assigned-1790000000000' })).toBe('cmf1x2');
    expect(feedItemFollowUp({ id: 'fu-cmf1x2-declined-1790000000000' })).toBe('cmf1x2');
    expect(feedItemFollowUp({ id: 'fu-cmf1x2-recalled-1790000000000' })).toBe('cmf1x2');
  });

  it('ignores every other feed item', () => {
    expect(feedItemFollowUp({ id: 'pa-123', alertType: 'fuelInconsistency' })).toBeNull();
    expect(feedItemFollowUp(null)).toBeNull();
  });
});

describe('needsMe', () => {
  it('counts what this viewer can accept or has to decide', () => {
    expect(needsMe(fu('OPEN'))).toBe(true);
    expect(needsMe(fu('ACCEPTED', { ownsIt: true }))).toBe(true);
  });

  it('does not count their own deletion, a case someone else holds, or a closed one', () => {
    expect(needsMe(fu('OPEN', { deletedIt: true }))).toBe(false);
    expect(needsMe(fu('ACCEPTED'))).toBe(false);
    expect(needsMe(fu('ESCALATED', { ownsIt: true }))).toBe(false);
  });
});

describe('needsMe, with assignment', () => {
  it('counts an assignment for the assignee only', () => {
    const assigned = (viewer) => fu('OPEN', viewer, { assignedTo: { fullName: 'Tess' } });
    expect(needsMe(assigned({ assignedToMe: true }))).toBe(true);
    expect(needsMe(assigned({}))).toBe(false);
  });

  it('drops a follow-up the viewer declined', () => {
    expect(needsMe(fu('OPEN', { declinedIt: true }))).toBe(false);
  });

  it('counts a declined, unheld follow-up for administrators', () => {
    expect(needsMe(fu('OPEN', { canAssign: true, declinedIt: true }, { needsAssigning: true }))).toBe(true);
    expect(needsMe(fu('OPEN', {}, { needsAssigning: true }))).toBe(true); // still anyone's to accept
    expect(needsMe(fu('OPEN', { declinedIt: true }, { needsAssigning: true }))).toBe(false);
  });
});

describe('followUpStage', () => {
  it('splits OPEN into waiting, assigned and needing an administrator', () => {
    expect(followUpStage(fu('OPEN'))).toBe('OPEN');
    expect(followUpStage(fu('OPEN', {}, { assignedTo: { fullName: 'Tess' } }))).toBe('ASSIGNED');
    expect(followUpStage(fu('OPEN', {}, { needsAssigning: true }))).toBe('NEEDS_ASSIGNING');
    expect(followUpStage(fu('ACCEPTED'))).toBe('ACCEPTED');
  });
});
