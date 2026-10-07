import { describe, expect, it } from 'vitest';
import { sprintsHref, toggleSprint } from './sprint-selection';

describe('sprint selection URL', () => {
  it('toggles a sprint on and off, up to the limit', () => {
    expect(toggleSprint([], 'a')).toEqual(['a']);
    expect(toggleSprint(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleSprint(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
  });

  it('writes the sprints parameter and keeps the others', () => {
    expect(sprintsHref('/boards/x', '?tab=1', ['a', 'b'])).toBe('/boards/x?tab=1&sprints=a%2Cb');
  });

  it('clearing removes the parameter', () => {
    expect(sprintsHref('/boards/x', '?sprints=a&tab=1', [])).toBe('/boards/x?tab=1');
    expect(sprintsHref('/boards/x', '?sprints=a', [])).toBe('/boards/x');
  });

  it('drops a stale error parameter', () => {
    expect(sprintsHref('/boards/x', '?error=unknown', ['a'])).toBe('/boards/x?sprints=a');
  });
});
