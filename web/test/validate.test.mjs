import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings } from '../src/validate.js';

const models = [{ id: 'luna', label: 'Luna', maxUsd: 2 }], limits = { maxReviewsPerDay: 12 };
const form = extra => ({ model: 'luna', maxUsd: '1', maxReviewsPerDay: '3', maxReviewsPerAuthor: '', ...extra });

// The server refuses anything but null or a whole number from 1 to 100,000, so the form
// sends null for a blank field and shows the reason next to the field for anything else.
test('a blank per-author limit means no limit and a number must be whole and positive', () => {
  assert.deepEqual(validateSettings(form(), models, limits), { errors: {}, value: { model: 'luna', maxUsd: 1, maxReviewsPerDay: 3, maxReviewsPerAuthor: null } });
  assert.equal(validateSettings(form({ maxReviewsPerAuthor: ' 25 ' }), models, limits).value.maxReviewsPerAuthor, 25);
  for (const bad of ['0', '1.5', '-2', 'ten', '100001']) {
    assert.match(validateSettings(form({ maxReviewsPerAuthor: bad }), models, limits).errors.maxReviewsPerAuthor, /leave it blank for no limit/, bad);
  }
});
