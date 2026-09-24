// Deterministic golden-comment matcher for the fifteen Martian development cases. Rules for
// the ten cases first run on 2026-09-24 were written from the comment text and changed
// file names before any run output was read.
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
  '006[0] unreachable branches': { file: 'insightsBooking.ts',
    all: [/unreachable|dead code|never (be )?(reached|evaluated|executed|taken)|always truthy|always (non-null|defined)/i, /filterConditions|else|branch|authConditions|getAuthorizationConditions/i] },
  '006[1] org without teams': { file: 'insightsBooking.ts',
    all: [/userIdsFromOrg|teamsFromOrg|org(ani[sz]ation)?[- ]level|org members|members of the org/i, /length > 0|no (child )?teams|without (child )?teams|empty|guard|exclud|omit|miss/i] },
  '009[0] import try-catch': { file: '', all: [/import/i, /try.?catch|unhandled|reject/i, /await|appStore|dynamic/i] },
  '009[1] forEach async': { file: '', all: [/forEach/i, /async|await|promise/i] },
  '015[0] feed URL SSRF': { file: 'poll_feed.rb',
    all: [/feed_polling_url|open\(|URL/i, /SSRF|server-side request|arbitrary|internal|validat|untrusted/i] },
  '015[1] indexOf origin': { file: 'embed.js',
    all: [/indexOf|origin/i, /bypass|insufficient|spoof|malicious|substring|prefix|evil|any domain|contains/i] },
  '015[2] postMessage targetOrigin': { file: 'layouts/embed.html.erb',
    all: [/postMessage|targetOrigin|target origin/i, /targetOrigin|target origin|dropped|scheme|origin rather|not an origin|full (referr?er )?URL/i] },
  '015[3] X-Frame-Options ALLOWALL': { file: 'embed_controller.rb', all: [/X-Frame-Options|ALLOWALL|clickjack|framing/i] },
  '015[4] TopicEmbed.import nil or XSS': { file: 'topic_embed.rb',
    all: [/nil|NoMethodError|XSS|escap|interpolat/i, /contents|url|import/i] },
  '015[5] end if in ERB': { file: 'best.html.erb', all: [/end if|syntax|invalid (Ruby|ERB)|will raise|parse/i] },
  '015[6] content.scrub nil': { file: 'poll_feed.rb',
    all: [/content/i, /nil|missing|absent|not (always )?(present|populated)|description|NoMethodError/i] },
  '015[7] referer XSS': { file: 'layouts/embed.html.erb', all: [/referr?er/i, /XSS|escap|inject|script/i] },
  '017[0] include_website_name': { file: 'user_serializer.rb',
    all: [/include_website_name|website_name|website_host|<</i, /suffix|question mark|trailing \?|`\?`|<<|mutat|frozen|concatenat|never called|not (be )?called|conditional/i] },
  '022[0] missing key prop': { file: 'rule-list/', all: [/GrafanaRuleListItem/, /\bkey\b/i] },
  '022[1] silence drawer needs ruler rule': { file: '',
    all: [/silenc/i, /rulerRule|ruler|promRule|drawer|no (visible )?effect|never render/i] },
  '028[0] missing double check': { file: 'webassets.go',
    all: [/double.?check|re-?check|another goroutine|already populated|populated by another|while waiting|redundant|concurren|race/i] },
  '028[1] error overwrites cache': { file: 'webassets.go',
    all: [/nil|error|\berr\b|unsuccessful/i, /cache|overwrit|entryPointAssetsCache/i] },
  '038[0] requireNonNull twice': { file: 'AccessTokenContext.java',
    all: [/requireNonNull|null/i, /rawTokenId|twice|duplicate/i] },
  '038[1] isAccessTokenId inverted': { file: 'AssertEvents.java',
    all: [/isAccessTokenId|substring|shortcut/i, /invert|revers|returns? false|opposite|wrong|negat|mismatch|indices|index/i] },
  '038[2] 3-letter javadoc': { file: '', all: [/3-letters?|three-letters?|3 letters?|2-letters?|two-letters?/i] },
  '038[3] broad RuntimeException': { file: 'DefaultTokenContextEncoderProviderTest.java',
    all: [/RuntimeException/, /broad|IllegalArgumentException|generic|specific/i] },
  '040[0] getSubGroupsCount null': { file: '', all: [/getSubGroupsCount/, /null|NPE|NullPointer/i] },
  '040[1] reader thread not joined': { file: 'GroupTest.java',
    all: [/thread|reader|join|wait/i, /race|flak|not (be )?(joined|waited)|before (the )?(thread|reader)|timing|concurren/i] },
  '042[0] optimized negative offset': { file: 'paginator.py',
    all: [/OptimizedCursorPaginator|enable_advanced_features|advanced feature/i, /negative|offset < 0/i] },
  '042[1] base paginator is_prev negative': { file: 'paginator.py', all: [/BasePaginator|is_prev/i, /negative|clamp/i] },
  '042[2] floor ceil on datetime': { file: 'paginator.py', all: [/floor|ceil|get_item_key/i, /datetime|TypeError/i] },
  '042[3] organization_context None': { file: 'organization_auditlogs.py',
    all: [/has_global_access|organization_context|member/i, /None|AttributeError|null/i] },
  '050[0] magic max_wait': { file: 'test_results_consumer.py',
    all: [/max_wait|magic number|\b50\b/i, /constant|magic|repeat|hard-?coded/i] },
  '050[1] docstring mismatch': { file: 'test_results_consumer.py', all: [/docstring/i] },
};
// Pass the case id ('case-009' or '009') whenever it is known: a rule with no file, such
// as 009[1] on any forEach with an async callback, would otherwise match another case.
export function matches(claim, caseId) {
  const location = claim.location ?? '', text = claim.description ?? '';
  const prefix = caseId ? `${String(caseId).replace(/^case-/, '')}[` : '';
  return Object.entries(RULES).filter(([id, rule]) => id.startsWith(prefix) &&
    (!rule.file || location.includes(rule.file)) && rule.all.every(pattern => pattern.test(text))).map(([id]) => id);
}
