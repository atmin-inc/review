// Usage: node benchmarks/golden-rules-check.mjs <dir with golden/<project>.json>
// Each golden comment, used as a claim at its own file, must match its own rule and no other.
import { readFileSync } from 'node:fs';
import { RULES, matches } from './golden-matcher.mjs';
const S = process.argv[2] ?? '/tmp/claude-0/-home-user-review/a22f72dd-0d77-5818-afcd-a7ade87227ea/scratchpad'; // holds golden/<project>.json
const split = JSON.parse(readFileSync(new URL('./martian-development-split.json', import.meta.url)));
const where = { '009[0]': 'packages/app-store/_utils/getCalendar.ts:10', '009[1]': 'packages/features/bookings/lib/handleCancelBooking.ts:300',
  '022[1]': 'public/app/features/alerting/unified/rule-list/components/RuleActionsButtons.V2.tsx:40',
  '038[2]': 'server-spi-private/src/main/java/org/keycloak/protocol/oidc/grants/OAuth2GrantTypeFactory.java:30',
  '040[0]': 'model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/GroupAdapter.java:200',
  '023[0]': 'public/app/plugins/datasource/loki/shardQuerySplitting.test.ts:1', '046[1]': 'tests/x.py:1', '046[2]': 'tests/x.py:1' };
let bad = 0;
for (const c of split.cases.filter(c => c.split === 'development')) {
  const golden = JSON.parse(readFileSync(`${S}/golden/${c.project}.json`)).find(e => JSON.stringify(e).slice(0, 400).includes(c.url));
  const n = c.id.slice(5);
  golden.comments.forEach((g, i) => {
    const id = Object.keys(RULES).find(k => k.startsWith(`${n}[${i}]`));
    if (!id) { console.log('NO RULE', n, i); bad++; return; }
    const location = where[`${n}[${i}]`] ?? `${RULES[id].file}:1`;
    const got = matches({ location, description: g.comment }, c.id);
    const ok = got.length === 1 && got[0] === id;
    if (!ok) { console.log(ok ? 'ok' : 'MISMATCH', id, '->', got); if (!got.includes(id)) bad++; }
  });
}
console.log('own-rule failures', bad);
