// The twelve human review comments on the five Martian development cases, written out by
// hand as claims in this repository's own schema, with real checks, and run against the
// frozen snapshots. It answers one question: is the claim schema or the rung-1 vocabulary
// the reason the reviewer misses comments? It is not — 24 of 25 propositions settle on
// grep alone and 11 of the 12 claims would ship with no model call.
//
// The exception is case-005's deleteMany, whose assertion is positional: "the retryCount
// branch of this OR carries no method filter". Literal search cannot ask where inside an
// expression something sits, so that proposition needs rung 3.
//
// Needs prepared snapshots, like the other scripts here. Point RUNS at a directory of
// case-<id>-r1 folders built by martian-prepare.mjs, then: node benchmarks/twelve-claims.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const RUNS = process.env.RUNS ?? 'martian-rep3';
const req = createRequire(import.meta.url);
const { revisionFrom, runCheck } = req('../dist/symbolic.js');

const F = {
  sms: 'packages/features/ee/workflows/api/scheduleSMSReminders.ts',
  hdr: 'app/assets/stylesheets/common/base/header.scss',
  mix: 'app/assets/stylesheets/common/foundation/mixins.scss',
  shard: 'public/app/plugins/datasource/loki/shardQuerySplitting.ts',
  shardT: 'public/app/plugins/datasource/loki/shardQuerySplitting.test.ts',
  idp: 'model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/idp/InfinispanIdentityProviderStorageProvider.java',
  idpTest: 'testsuite/integration-arquillian/tests/base/src/test/java/org/keycloak/testsuite/organization/cache/OrganizationCacheTest.java',
  asrc: 'src/sentry/integrations/services/assignment_source.py',
  atest: 'tests/sentry/integrations/services/test_assignment_source.py',
};
const fc = (path, pattern, expect = 'present', revision = 'head') =>
  ({ assertion: 'file_contains', path, pattern, expect, revision });

const CLAIMS = [
  { id: '005[0] concurrent retryCount', c: '005', props: [
    ['the update writes a value read earlier', fc(F.sms, 'retryCount: reminder.retryCount + 1')],
    ['no atomic increment is used', fc(F.sms, 'increment:', 'absent')],
    ['no transaction wraps the read and write', fc(F.sms, '$transaction', 'absent')]]},
  { id: '005[1] deleteMany non-SMS', c: '005', props: [
    ['the delete is scoped by an OR', fc(F.sms, 'OR:')],
    ['the delete filters on retryCount', fc(F.sms, 'retryCount: {')],
    ['NEEDS RUNG 3: the retryCount branch carries no method filter', null]]},
  { id: '016[0] float vs flexbox', c: '016', props: [
    ['the header is a flex container', fc(F.hdr, '@include flexbox()')],
    ['a float remains inside it', fc(F.hdr, 'float:')]]},
  { id: '016[1] -ms-align-items', c: '016', props: [
    ['the mixin emits -ms-align-items', fc(F.mix, '-ms-align-items')],
    ['the mixin also emits the real legacy property', fc(F.mix, '-ms-flex-align')]]},
  { id: '016[2] ordinal-group from 1', c: '016', props: [
    ['the mixin passes the raw value to box-ordinal-group', fc(F.mix, 'box-ordinal-group')],
    ['no offset is applied to the value', fc(F.mix, 'ordinal-group: $val + 1', 'absent')]]},
  { id: '023[0] test omits filters', c: '023', props: [
    ['the call site passes request.filters', fc(F.shard, 'request.filters')],
    ['the test setup never passes filters', fc(F.shardT, 'request.filters', 'absent')]]},
  { id: '032[0] cache re-entry', c: '032', props: [
    ['getForLogin resolves through the session provider', fc(F.idp, 'session.identityProviders().getById')],
    ['the delegate is what other paths use', fc(F.idp, 'idpDelegate')]]},
  { id: '032[1] wrong alias', c: '032', props: [
    ['cleanup asks for the literal alias', fc(F.idpTest, 'identityProviders().get("alias")')],
    ['the IDPs are created with a generated alias', fc(F.idpTest, 'idp-alias-')]]},
  { id: '046[0] mutable default', c: '046', props: [
    ['the field default calls timezone.now at class scope', fc(F.asrc, 'queued: datetime = timezone.now()')],
    ['no default_factory is used', fc(F.asrc, 'field(default_factory', 'absent')]]},
  { id: '046[1] test name typo', c: '046', props: [
    ['the test is named with the typo', fc(F.atest, 'inalid_data')]]},
  { id: '046[2] empty_array names a dict', c: '046', props: [
    ['the test is named empty_array', fc(F.atest, 'empty_array')],
    ['it is about a dict, not an array', fc(F.atest, 'empty_array')]]},
  { id: '046[3] datetime round-trip', c: '046', props: [
    ['to_dict emits the raw datetime field', fc(F.asrc, 'queued')],
    ['nothing serialises it to a string', fc(F.asrc, 'isoformat', 'absent')]]},
];

const revs = {};
for (const c of ['005','016','023','032','046']) {
  const p = JSON.parse(readFileSync(`${RUNS}/case-${c}-r1/packet.json`,'utf8'));
  revs[c] = revisionFrom(`${RUNS}/case-${c}-r1/source.git`, p.headSha);
}
let settled = 0, total = 0, blocked = 0;
for (const claim of CLAIMS) {
  console.log(`\n${claim.id}`);
  let ok = true;
  for (const [text, check] of claim.props) {
    total++;
    if (!check) { console.log(`   -- ${text}`); ok = false; blocked++; continue; }
    const out = runCheck(revs[claim.c], check);
    const ev = out.evidence[0];
    const good = ev && ev.result === 'hit';
    if (good) settled++; else ok = false;
    console.log(`   ${good ? 'OK  ' : 'FAIL'} ${text}`);
    if (!good) console.log(`        -> ${ev ? ev.result + ': ' + ev.check : out.limitations[0]}`);
  }
  console.log(`   ==> ${ok ? 'WOULD SHIP on rung 1 alone' : 'needs more'}`);
}
console.log(`\npropositions settled by rung 1: ${settled}/${total}  (${blocked} cannot be expressed as a check)`);
