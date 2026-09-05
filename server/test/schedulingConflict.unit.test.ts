import { describe, expect, it } from 'vitest';
import { isDoubleBookConflictError } from '../lib/scheduling';

describe('double-book database error normalization', () => {
  it.each([
    { code: '23P01' },
    { code: 'P2034', message: 'Transaction failed due to a write conflict' },
    { code: 'P2004', meta: { database_error: 'Exclusion constraint failed on appointment_no_double_book' } },
    { code: 'P2004', cause: { code: '23P01' } },
  ])('recognizes every supported PostgreSQL/Prisma race shape', error => {
    expect(isDoubleBookConflictError(error)).toBe(true);
  });

  it('does not turn an unrelated uniqueness failure into a double-book response', () => {
    expect(isDoubleBookConflictError({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
  });
});
