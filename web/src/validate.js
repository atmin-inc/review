// Form validation mirrors the server's limits so people see the reason next to the field.
// The server stays authoritative; its error sentence is shown when it still refuses.
import { usd } from './format.js';

const whole = text => (/^\s*\d+\s*$/.test(text) ? Number(text) : NaN);
const decimal = text => (/^\s*\d+(\.\d+)?\s*$/.test(text) ? Number(text) : NaN);

export function validateSettings(form, models, limits) {
  const errors = {};
  const model = models.find(m => m.id === form.model);
  if (!model) errors.model = 'Choose a model.';
  const maxUsd = decimal(form.maxUsd);
  if (Number.isNaN(maxUsd)) errors.maxUsd = 'Enter an amount in US dollars, like 0.50.';
  else if (model && maxUsd > model.maxUsd) errors.maxUsd = `Enter at most ${usd(model.maxUsd)} for ${model.label}.`;
  const maxReviewsPerDay = whole(form.maxReviewsPerDay);
  if (!(maxReviewsPerDay >= 1 && maxReviewsPerDay <= limits.maxReviewsPerDay)) {
    errors.maxReviewsPerDay = `Enter a whole number from 1 to ${limits.maxReviewsPerDay}.`;
  }
  return { errors, value: { model: form.model, maxUsd, maxReviewsPerDay } };
}

export const planFields = [
  { key: 'freeReviews', label: 'Free reviews a month', kind: 'count' },
  { key: 'monthlyReviews', label: 'Monthly review limit', kind: 'count' },
  { key: 'multiplier', label: 'Cost multiplier', kind: 'multiplier' },
  { key: 'minimumUsd', label: 'Minimum charge per review (USD)', kind: 'usd' },
];

export function validatePlan(form) {
  const errors = {}, value = {};
  for (const field of planFields) {
    if (field.kind === 'count') {
      value[field.key] = whole(form[field.key]);
      if (!(value[field.key] <= 100000)) errors[field.key] = 'Enter a whole number from 0 to 100,000.';
    } else {
      value[field.key] = decimal(form[field.key]);
      if (!(value[field.key] <= 10)) errors[field.key] = 'Enter a number from 0 to 10.';
    }
  }
  return { errors, value };
}
