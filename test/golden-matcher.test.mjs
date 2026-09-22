import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches } from '../benchmarks/golden-matcher.mjs';

// Hand matching of golden comments was wrong twice on 2026-09-21, in both directions, and
// every experiment result rests on it. These cases pin the decisions the matcher was
// tuned on, so a change to a rule that silently moves a benchmark number fails here first.
const SMS = 'packages/features/ee/workflows/api/scheduleSMSReminders.ts:28';
const MIX = 'app/assets/stylesheets/common/foundation/mixins.scss:115';
const IDP = 'model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/idp/InfinispanIdentityProviderStorageProvider.java:249';

test('a claim naming the defect in other words still matches', () => {
  // Held-out misses from the first draft of the rules: the wording differed, the defect did not.
  assert.deepEqual(matches({ location: SMS,
    description: 'The deleteMany query deletes ANY workflow reminder with retryCount > 1 regardless of method, not just SMS reminders' }),
    ['005[1] deleteMany non-SMS']);
  assert.deepEqual(matches({ location: MIX,
    description: 'align-items mixin includes -ms-align-items property which is not a valid CSS property' }),
    ['016[1] -ms-align-items']);
});

test('a different defect in the same file does not match', () => {
  // Held-out false matches from the first draft: each shared a word with a golden comment
  // and described something else. Counting them would have inflated recall.
  assert.deepEqual(matches({ location: SMS,
    description: 'The error handling increments retryCount in both the else block and the catch block. This could lead to double counting of retries for the same failure.' }), []);
  assert.deepEqual(matches({ location: IDP,
    description: 'The getForLogin cache key does not include organizationId, causing all organization searches to share the same cache entry' }), []);
  assert.deepEqual(matches({ location: IDP,
    description: 'The getForLogin method may throw NullPointerException if idpDelegate.getForLogin returns null' }), []);
  // From the pilot set: names WhatsApp and deletion, but says WhatsApp lacks the logic,
  // not that the delete reaches WhatsApp reminders.
  assert.deepEqual(matches({ location: SMS,
    description: 'The retry logic is inconsistent with WhatsApp reminders, which don\'t have retryCount increments or deletion logic.' }), []);
});

test('the right words in the wrong file do not match', () => {
  assert.deepEqual(matches({ location: 'app/assets/stylesheets/common/base/topic.scss:10',
    description: '-ms-align-items is not a valid CSS property' }), []);
});
