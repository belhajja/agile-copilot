import { describe, expect, it } from 'vitest';
import { entitlementsOf, PLANS, withinLimit } from './plans';

describe('plans', () => {
  it('keeps the paid plan while Stripe says active, trialing or past_due', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(entitlementsOf({ plan: 'team', status })).toEqual(PLANS.team);
    }
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(entitlementsOf({ plan: 'team', status })).toEqual(PLANS.free);
    }
    expect(entitlementsOf(null)).toEqual(PLANS.free);
    expect(entitlementsOf({ plan: 'enterprise', status: 'active' })).toEqual(PLANS.free);
  });

  it('checks limits, null meaning unlimited', () => {
    expect(withinLimit(3, 2)).toBe(true);
    expect(withinLimit(3, 3)).toBe(false);
    expect(withinLimit(3, 1, 3)).toBe(false);
    expect(withinLimit(null, 10_000)).toBe(true);
  });
});
