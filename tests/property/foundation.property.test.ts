import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('local property-test tooling', () => {
  it('runs the configured minimum number of in-memory cases', () => {
    let caseCount = 0;

    fc.assert(
      fc.property(fc.integer(), (value) => {
        caseCount += 1;
        return Number.isInteger(value);
      }),
    );

    expect(caseCount).toBeGreaterThanOrEqual(100);
  });
});
