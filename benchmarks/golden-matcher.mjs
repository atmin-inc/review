// Deterministic golden-comment matcher for the five Martian development cases run here.
// Replaces hand matching, which was wrong twice on 2026-09-21. A claim matches a golden
// comment when it is located in the comment's file and its description satisfies every
// token group (each group is any-of). Rules are written from the comment text and checked
// against the 13 hand labels in rep3-golden.json; disagreements are printed, not hidden.
//
// The standard, stated so it can be argued with: a claim matches when it names the thing
// the human comment says is wrong, at the place the comment says it is wrong, even when
// it describes the consequence differently. That is the standard the hand labels used
// (case-032-r2 names session.identityProviders().getById() in getForLogin and predicts a
// different failure than recursion; it was counted). An LLM judge may be stricter or
// looser; this is deterministic, which is the point.
export const RULES = {
  '005[0] concurrent retryCount': { file: 'scheduleSMSReminders.ts',
    all: [/retryCount/i, /concurren|race condition|stale|atomic|simultaneous|lost update|lose increments/i] },
  '005[1] deleteMany non-SMS': { file: 'scheduleSMSReminders.ts',
    all: [/delet(e|es|ed|ing)\b|deleteMany/i, /retryCount|retry count/i, /non-SMS|not SMS|not just SMS|only SMS|SMS method|to SMS|beyond SMS|method:\s*(WorkflowMethods\.)?SMS|regardless of method|not.*constrained|any method|email|whatsapp|OR instead of AND|should be AND|both clauses|method (filter|constraint)/i] },
  '016[0] float vs flexbox': { file: 'header.scss', all: [/float/i] },
  '016[1] -ms-align-items': { file: 'mixins.scss',
    all: [/ms-align-items|ms-flex-align/i, /duplicat|incorrect|invalid|not a valid|not valid|not a standard|non-?standard|never existed|typo|wrong|does not exist|non-?existent|not work in any/i] },
  '016[2] ordinal-group from 1': { file: 'mixins.scss', all: [/ordinal-group/i, /\b0\b|zero|start|from 1|1-based|one-based/i] },
  '023[0] filters unused in test': { file: '', all: [/applyTemplateVariables/, /filters/i, /test/i] },
  '032[0] cache re-entry': { file: 'InfinispanIdentityProviderStorageProvider.java',
    all: [/identityProviders\(\)\.getById|recurs|re-?enter|reentr|bypass(es)? the cache/i] },
  '032[1] wrong alias': { file: 'OrganizationCacheTest.java', all: [/alias/i] },
  '046[0] shared default datetime': { file: 'assignment_source.py',
    all: [/timezone\.now|default/i, /class definition|shared|once|default_factory|evaluat|import time/i] },
  '046[1] inalid typo': { file: '', all: [/inalid/i] },
  '046[2] empty_array name': { file: '', all: [/empty_array/i] },
  '046[3] datetime round-trip': { file: 'assignment_source.py',
    all: [/seriali|JSON|isoformat|to_dict|from_dict|round.?trip/i, /datetime|queued/i] },
};
export function matches(claim) {
  const location = claim.location ?? '', text = claim.description ?? '';
  return Object.entries(RULES).filter(([, rule]) =>
    (!rule.file || location.includes(rule.file)) && rule.all.every(pattern => pattern.test(text))).map(([id]) => id);
}
