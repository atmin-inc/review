# Source audit — paired controller repeats

Source audit of all 15 development cases and selected findings from the completed 60-attempt comparison. See the [final results](paired-comparison-2026-09-14.md) for raw per-case scores and all seven partial outcomes. These judgments do not alter the pinned upstream score. This is not an exhaustive precision estimate for every emitted claim. This is a source-level audit, not an independent blinded study: the auditor has seen the earlier pilot and annotations. No audit observation enters running reviewer context. No historical application has been executed.

## case-032 — Keycloak 32918

- **Expected recursive cache lookup: disputed annotation.** Head `InfinispanIdentityProviderStorageProvider.java:214–254` calls the distinct `getById` at 246. That method at 123–142 reads its own entry or delegates to `idpDelegate.getById`; it does not return to `getForLogin`. The expected Critical recursion does not establish a failing cycle. This repeats the earlier audit, rechecked against this frozen packet.
- **Expected cleanup alias typo: supported defect.** New `OrganizationCacheTest.testCacheIDPForLogin` creates `idp-alias-<i>` but schedules cleanup of literal `alias`; the subsequent provider 20 uses the same incorrect cleanup. Missing this is a local changed-code reasoning/selection gap if the receipt shows these lines were read.
- **Extra stale login membership while organization disabled: supported at source level.** `InfinispanIdentityProviderStorageProvider.update:91–94` obtains the original via organization-aware getById; wrapper `isEnabled:436–441` becomes false when its organization is disabled. Eligibility-changing update can then make both original and new fail the login predicate, causing the early return at 405–406. `OrganizationAdapter.setEnabled:110–112` invalidates organization state through `InfinispanOrganizationProvider:300–314`, without invalidating login-query keys. On re-enable, the login bean rechecks enabled state but not hidden/public/link-only, so stale cached IDs can become visible. Individual entry invalidation does not invalidate the list membership. A full Keycloak integration reproduction remains outstanding.

## case-023 — Grafana 107534

- **Expected missing request.filters coverage: supported test gap.** `querySplitting.test.ts:49–58,75–87` supplies expr and step but no filters. `shardQuerySplitting.test.ts:53–60` changes the mock to accept only query and ignores the newly forwarded third argument; interpolation tests likewise lack filters. The source warrants a narrow regression check.
- **Extra repeated interpolation/filtering: supported call chain; literal-dollar impact needs an integration reproduction.** Changed `querySplitting.ts:299` adds applyTemplateVariables; shard wrapper also applies it. `LokiDatasource.runQuery:350–352` calls the inherited query builder, which defaults shouldApplyTemplateVariables=true at `DataSourceWithBackend.ts:151` and calls applyTemplateVariables at 185 for ordinary Loki queries. `LokiDatasource.applyTemplateVariables:1127–1129` interpolates existing text before inserting ad-hoc filters. That establishes repeated transformations; replacing dollar-containing inserted filter text on a later pass is plausible from this chain, but was not executed here. Earlier shard code also interpolated before backend execution, so avoid calling every double-interpolation scenario wholly new: the new time-split stage and request.filters forwarding extend it.
- **Reporting/judging disagreement to retain separately.** A report's verification criterion explicitly mentions that request.filters is not exercised yet may receive zero matches. Compare extracted candidates and labels at finalization rather than treating a zero as proof of no awareness. The raw score remains unchanged.

## case-050 — Sentry 95633

- **Expected error-test docstring mismatch: supported documentation defect.** `test_results_consumer.py:1874–1877` says errors do not block commits for other messages, but after two messages (one failure) lines 1921–1922 assert there are no commits for the partition. Several reports discuss the test/implementation conflict without explicitly identifying the docstring mismatch. Those are related observations, not automatically an exact match.
- **Worker exception marked complete: supported extra defect, impact needs calibration.** New `queue_consumer.py:135–149` invokes the processor and completes the offset in finally, including escaping exceptions. `_commit_loop:276–289` commits completed offsets. The existing ResultProcessor.__call__ catches ordinary subscription lookup/handler Exceptions at result_consumer.py:40–50, so normal handler failure was already swallowed at base; the finding must concern an exception that escapes the callable, not claim ordinary handler-error loss is newly introduced. The new strategy explicitly promises successful-processing-only commits at queue_consumer.py:250–254, and its worker/error test support an escaping-callable contract violation. P1 vs P2 disagreement should not count as discovery disagreement. The test waits 0.2 seconds after drain (`1917`) while commits wait one second (`276`), so it does not reliably test eventual behavior.
- **Factory pool destroyed by strategy close: supported extra lifecycle defect.** Factory constructs the pool once (`result_consumer.py:131–137`) and reuses it when creating strategies (`200–210`). Strategy close destroys it (`queue_consumer.py:335–345`). A subsequent creation around the closed pool has no workers; submit catches failure and marks the message complete (`317–325`). Supported create-close-create failure; actual Kafka rebalance reproduction not run.
- **Unbounded queues: supported extra reliability defect.** `queue_consumer.py:184–185` constructs queues without a finite maxsize. Submission always enqueues and poll at 327–333 reports a metric without limiting ingestion. Retained WorkItems include decoded and original messages, with offset sets also growing. Sustained producer/worker imbalance has no local backpressure. The exact workload/time to OOM is unmeasured.
- **Negative worker count: supported extra configuration defect.** Factory's max_workers-or-20 preserves negative values; pool range then creates no workers. `src/sentry/consumers/__init__.py:138–141` exposes the uptime option with unrestricted type=int. Submission failure follows the same acknowledge-on-error mechanism. Group the downstream data-loss symptom with that mechanism, retaining invalid configuration as a distinct trigger.
- The style-only max_wait constant annotation is excluded by the Core profile.


## case-009 — Cal.com 8087

- **Expected async-forEach cleanup: supported, but scope should identify the new regression.** Both reschedule helpers change a synchronous callback into an async callback and add an await before deletion. The outer forEach ignores its returned promise; surrounding try/catch cannot catch the async callback rejection. Some downstream delete/refund promises were already unawaited at base, so describing every asynchronous cleanup problem as introduced here overstates the diff. Follow callers and new suspension/error behavior, and group repeated occurrences as one class.
- The import-failure try/catch suggestion is speculative and excluded from Core.

## case-017 — Discourse mirrored PR 6

- **Expected missing predicate suffix: supported framework-contract concern.** `user_serializer.rb:153–155` defines include_website_name without ?. Nearby conditional hooks include ? and the class's own untrusted_attributes helper constructs `include_#{attr}?` at 27. The existing dependency is active_model_serializers 0.8.3. This source supports the naming mismatch; a full framework serialization reproduction has not been run in this audit.
- **Expected string-literal mutation clause: not an independently established failure.** The operation mutates a local literal; no shared frozen literal or reuse across calls is established in this Ruby-era code. The annotation combines this suggestion with the stronger predicate issue, so its upstream match must not imply both claims are proven.
- **Extra untrusted-profile exposure: supported source path.** New website_name is registered at 44 and read from model.website_name by the template. The existing untrusted_attributes list at 105–111 includes website but omits website_name; helper returns false for scope.restrict_user_fields?(object). The new method also omits that privacy check. Thus a host/path can appear where website itself is suppressed. This is related to but distinct from the missing ? hook.

## case-042 — Sentry mirrored PR 2

- **Expected optimized negative slice: supported code defect.** New advanced branch passes cursor.offset directly into queryset slicing when negative. `Cursor.__init__:28` and from_string:59 retain arbitrary integer offsets. The new comments asserting ORM support are contradicted by the slicing contract. Integration reproduction remains outstanding.
- **Expected base-paginator previous-page slice: pre-existing mechanism.** Base used queryset[offset:stop] without clamping; head clamps only forward requests and leaves previous behavior unchanged. The cursor constructor change adds comments only, not a changed offset parser. No separately introduced base-path failure is established. Keep it in raw score but mark disputed introduction.
- **Expected datetime arithmetic: supported defect.** Endpoint selects the new paginator with order_by=-datetime; get_item_key applies math.floor/ceil directly to the datetime rather than the existing DateTimePaginator conversion. This fails on nonempty results.
- **Expected nullable member: supported reachable authorization defect.** New enable_advanced dereferences organization_context.member before checking use_optimized. RpcUserOrganizationContext.member is optional (`organizations/services/organization/model.py:331–346`). ControlSiloOrganizationEndpoint passes a non-null context after authorization (`api/bases/organization.py:282–308`), but authentication via an organization API token can use ApiBackedOrganizationGlobalAccess without membership (`auth/access.py:942–943,1178–1194,681–703`). Such a permitted non-superuser request can fail on member.has_global_access even without requesting optimized pagination. The annotation incorrectly says the context is None; the supported null value is its member. Both r1 versions read the entire changed endpoint and its tests. Baseline also read only model.py:1–200, missing the actual optional-member declaration at 346; candidate did not capture that model definition or the authorization implementation. This is an observed dependency-investigation gap, not absence of the changed file from context.


## case-006 — Cal.com 22345

- **Expected unreachable branches: supported dead-code observation; functional severity unproven.** `insightsBooking.ts:68–87` obtains authorization as a non-null Prisma.Sql and branches on its truthiness; the last two branches are unreachable. buildAuthorizationConditions uses a SQL false condition when access is absent, which remains an object. This is an opportunity to simplify a security-sensitive decision tree, but the unreachable branches alone do not demonstrate unauthorized access or wrong results. A reviewer should not invent a production failure to fit the benchmark's bug category.
- The organization-without-child-teams suggestion remains excluded from Core. Any reported runtime issue needs a reachable caller: the service and its tests already exist at base. An independent source search for InsightsBookingService in both revisions finds only the service and its integration test, so no production caller was established; hypothetical construction scenarios are not automatically production incidents.

## case-038 — Keycloak 37634

- **Expected duplicated null check: supported contract defect.** `AccessTokenContext.java:69–77` checks grantType twice and never checks rawTokenId despite its message. Null rawTokenId can enter the new value object.
- **Expected grant matcher: supported test oracle defect.** New `AssertEvents.isAccessTokenId` uses substring(3,5) instead of the encoder's grant region (4,6), and returns false on equality. Encoder uses two characters each for session, token, and grant before colon. Both wrong index and inverted predicate are one expected annotation; splitting them during extraction can obscure matching. Its effect is accepting incorrect token context or failing assertions, not directly a production token-validation bypass.
- **Expected Javadoc shortcut length: supported documentation defect.** `OAuth2GrantTypeFactory.java:30` describes a usual three-letter shortcut, while new factories and the encoder use two-character slots. Low priority; runtime findings should not be inflated by it.
- **Expected broad RuntimeException catch: supported test weakness, not an established runtime bug.** `DefaultTokenContextEncoderProviderTest.java:79–83` accepts any RuntimeException for malformed grant context. The provider's documented/implemented failure is IllegalArgumentException; an unrelated runtime exception could satisfy the test. Keep the upstream bug categorization, but distinguish impact in the source audit.

## case-046 — Sentry 77754

- **Expected dataclass default timestamp: supported defect.** `assignment_source.py:18` calls timezone.now at class definition; from_integration creates instances without an explicit queued value at 22–25. These instances share the same old timestamp. The frozen dataclass does not make the timestamp fresh.
- **Expected JSON serialization failure: configuration-dependent and not established for this repository.** to_dict returns asdict (including datetime), but `src/sentry/conf/server.py:739–741` selects/accepts pickle for Celery, which supports datetime. A JSON deployment would need a conversion, but the default task path does not establish the annotated enqueue failure. This rechecks the earlier audit against the frozen packet.

## case-040 — Keycloak 40940

- **Expected nullable subgroup count: supported contract mismatch; check caller impact separately.** New `GroupAdapter.getSubGroupsCount:274–276` returns null when modelSupplier returns null. The previous method would throw on that missing backing model. A count contract claiming non-null is violated, but changing a throw to null is not automatically a new endpoint crash; inspect consumers before assigning functional severity.
- **Expected reader-thread race: supported test gap.** New GroupTest starts a reader thread without retaining/joining it, sets deletedAll then immediately checks caughtExceptions. A request already in flight can fail and append after the assertion. AtomicBoolean and CopyOnWriteArrayList make the shared operations safe but do not synchronize completion.

## case-028 — Grafana 90939

- **Expected missing second cache check: supported concurrency defect.** A caller snapshots nil under RLock, releases it, then waits for Lock. Another caller may populate the cache in between, but the waiting caller fetches again without inspecting the populated cache. The new lock serializes redundant fetches; a later fetch error can replace the fresh cache with nil.
- **Expected unconditional assignment: existing statement, overlapping mechanism.** The assignment itself is unchanged from base. Its combination with the new incomplete locking sequence supports the failure above; treating it as a second independently introduced issue double-counts the same causal chain unless a distinct trigger is established. Raw matching retains both expected annotations.


## case-005 — Cal.com 14943

- **Expected stale retry increment: supported concurrency concern.** New success-empty and catch branches write reminder.retryCount+1 from the earlier query snapshot. Overlapping invocations can write the same increment. Provider scheduling locks do not make the later database read/modify/write atomic, and a lock-busy result can itself enter the new empty-result increment path. The policy effect is inaccurate retry exhaustion, rather than an automatic duplicate SMS claim.
- **Expected non-SMS deletion: predicate broadening supported, current trigger unproven.** The new OR retryCount>1 branch lacks method=SMS. However, the migration initializes all counts to zero and inspected writers increment SMS reminders. A non-SMS row above the threshold requires a supported writer, method transition, or external data state. Keep the raw expected label without claiming a demonstrated current Email/WhatsApp loss.
- Previously observed extra concerns—lock-busy result consumes attempts and a failed database update inside catch aborts the remaining batch—must be adjudicated separately from the two sparse expected labels.

## case-016 — Discourse mirrored PR 5

- **Expected header layout: supported structural concern; visual reproduction outstanding.** The PR removes panel float-right and relies on margin-left:auto/order on the new flex container. The non-Ember layout's nested row means panel is not necessarily a direct flex item. This warrants the specific fallback-header check, not a generic claim that any float/flex combination is invalid.
- **Expected unknown -ms-align-items: redundant invalid declaration, independent behavior defect unproven.** Correct -ms-flex-align remains immediately before it. The extra unknown declaration does not by itself cancel the valid fallback.
- **Expected ordinal zero: hypothetical input.** The changed call sites use order(2) and order(3), and no zero call is established. A generic mixin mismatch with old box ordering is a compatibility concern; do not invent a zero-input runtime failure. These last two limitations were also recorded in the earlier source audit.

## case-022 — Grafana 106778

- **Expected missing React key: supported local regression.** The FilterView mapping removes key={key} when replacing GrafanaRuleLoader with GrafanaRuleListItem. The separate GrafanaGroupLoader mapping retains key={promRule.uid}; inspecting only that caller would incorrectly dismiss the annotation.
- **Expected inert silence action: supported cross-component contract defect.** New GrafanaRuleListItem:47 passes promRule without the old Ruler rule. RuleActionsButtons.V2:100 toggles showSilenceDrawer but 104–105 renders the drawer only when rulerRuleType.grafana.alertingRule(rule) succeeds. The new Grafana Prom abilities can enable Silence at useAbilities:323 even though that Ruler object is absent. Thus allowed users can see an action that does nothing. This is the kind of caller/callee data-shape change review needs to follow across files.

## case-015 — Discourse mirrored PR 4

- **Expected invalid ERB closure: supported syntax defect.** Frozen head `app/views/embed/best.html.erb:6` is `<%- end if %>`. The earlier audit's retained ERB compilation plus ruby -c failed on the generated closure; this experiment copies the same original source packet. No template/application execution was needed to establish the syntax failure. Keep this deterministic language-check gap distinct from deeper security reasoning.
- **Expected missing feed content: supported input-shape concern.** PollFeed:35 calls i.content.scrub without a nil fallback. A content-less item reaches it unless the parser/caller supplies a default; inspect dependency behavior before claiming every feed triggers it.
- **Expected TopicEmbed nil/unescaped URL: mixed annotation requiring separate triggers.** Nil contents fails at string append if admitted; raw URL interpolation into generated HTML also requires checking URL trust and subsequent sanitization. These should not be accepted as one proven exploit merely because one clause matches.
- **Expected feed URL SSRF: trust boundary needs calibration.** PollFeed:29 opens a site-admin setting directly. It can fetch internal resources, but an attacker controlling that setting is a privileged actor. Compare the product's URL-fetching protections and accepted administrator capabilities before assigning security impact.
- **Expected origin substring: broader issue supported, example incorrect.** The containment direction does not admit the annotation's evil-prefix example as stated. A shorter prefix origin such as https://www.example.co versus https://www.example.com/ does fit the code. Exact-origin comparison is appropriate; observed message handler impact is iframe sizing.
- **Expected full postMessage target URL: disputed.** The HTML algorithm parses the target as a URL and then uses its origin; a path does not by itself prevent delivery. [HTML Standard](https://html.spec.whatwg.org/multipage/web-messaging.html#dom-window-postmessage-options-dev).
- **Expected framing/referer bypass: unresolved exploit.** The endpoint is intentionally embeddable and validates referer host. A generic HTTP client can spoof referer, but that alone does not establish a malicious browser framing exploit. A concrete attacker-controlled browser path is needed.
- **Expected referrer interpolation XSS: unresolved after escaping.** Ordinary escaped ERB output is present, without raw/html_safe. JavaScript-context safety merits checking, but an exploit must account for that escaping. Preserve this uncertainty rather than repeating the annotation as demonstrated XSS.

## Supplemental framework sources

Django's QuerySet implementation rejects negative indices before slicing ([Django 5.0 source](https://docs.djangoproject.com/en/5.0/_modules/django/db/models/query/)). Redis ZUNIONSTORE adds duplicate members' scores unless another aggregation is selected ([Redis documentation](https://redis.io/docs/latest/commands/zunionstore/)); the new Lua union has no aggregation override. A repeated payload present in temporary and final sets can therefore inflate a timestamp and distort eviction ordering. The pipeline/replay trigger is supported by the source call chain, but no live Redis/Kafka reproduction was run here.

## Observed grading caveats (keep original score)

- Discourse PR 6: both r1 reports and their extracted candidates explicitly mention the missing question mark, but neither matches the combined question-mark/string-mutation golden comment. This is a semantic grading disagreement, not total reviewer blindness to the hook.
- Grafana 107534: one r1 report explicitly mentions absent request.filters coverage in verification but receives no match, while the other receives one. Compare exact extracted claims; do not infer inspection quality solely from the match bit.
- Sentry mirrored PR 2: one new-optimized-paginator candidate matches both the optimized and base-paginator annotations. This can count two expected bugs from one root cause even though the separately annotated base behavior is unchanged.
- Upstream evaluate_review marks a candidate matched only when its confidence exceeds the best previous candidate for that golden comment. A later true match with equal/lower confidence may remain a false positive unless dedup propagation covers it. Negative judgments are not retained with reasoning. These are limitations of the pinned scorer; this run does not alter them.
- Full-report extraction expands consequences, test suggestions, codebase-fit concerns, and operational validation limitations into additional candidates. Dedup only protects siblings of a matched issue; unannotated duplicate descriptions can each remain false positives. Compare unique source-supported defects separately without editing the raw counts.


## Reliability and instrumentation

The first baseline review of case-038 ended partial after 515,415 ms and 28 model requests, with four accepted findings, quality recorded, all 28 files marked reviewed, and zero unsettled calls. Its last response had known usage (233 output tokens) but adapter status incomplete. The candidate completed in about 349 seconds. No attempt is retried.

Detailed local-adapter events are absent from baseline traces: the common adapter imports engine/dist/trace.js, while baseline runReview owns baseline/dist/trace.js. Each has a separate AsyncLocalStorage. Controller spans, source reads, receipts and usage remain available, but the baseline's adapter-stage rejection reason is not captured. Do not claim this was context exhaustion, a model refusal, or a network timeout. The next harness revision loads the byte-identical adapter through each matching runtime (also preserving ProviderRequestError class identity); an offline regression check verifies module identity. This experiment's frozen reviewer harness remains unchanged.

The offline upstream-confidence-demo.json proves the stated confidence-order behavior without API calls. It does not quantify how many live false-positive labels were caused by that behavior, because negative/equal-confidence judgments are not retained by upstream.


## Additional adjudication notes from completed r1 reports

- Keycloak 37634: baseline found a new abstract grant-factory method that can break previously compiled extension providers. The mechanical binary incompatibility is plausible, but classifying it as a P1 product bug requires the repository's compatibility/support promise for such extensions. No independent compatibility guarantee or extension reproduction was established here; keep this extra claim unresolved rather than counting it as proven useful output.
- Keycloak 37634: baseline and candidate both discuss the three-character documentation/two-character encoding mismatch, but only baseline r1 receives the documentation match. Candidate r1 catches the missing rawTokenId null check while baseline r1 does not. Separate those two observations: one is a grading disagreement, the other is an actual final-finding difference.
- Grafana 90939: both r1 versions describe the missing second cache check and its effects. Baseline receives both expected matches; candidate receives only the first. This illustrates how one causal finding can count differently under overlapping annotations.


## Confirmed false-positive mechanism: partial dependency inspection

Candidate r1 in Discourse PR 4 reports `retrieve-topic-missing-open-uri`, claiming a fresh background job reaches URL-aware open without loading open-uri. Frozen `app/jobs/regular/retrieve_topic.rb:7` inherits Jobs::Base. That base file explicitly requires all regular and scheduled jobs at **218–219**, including `app/jobs/scheduled/poll_feed.rb`, whose line 7 requires open-uri. Production also enables eager loading. This disproves the asserted normal fresh-job load-order failure at source level; the broad rake variant would need separate investigation. The review captured **base.rb:1–180** only, although it captured the full PollFeed file and the production configuration. It therefore treated a partially inspected module as evidence that initialization was absent.

Together with Sentry's missed optional member at model.py:346 after a prefix read ending at 200, this supports a recurring dependency-navigation gap in two unrelated codebases, affecting both precision and recall. Increasing suspicion or adding more generic review instructions would not establish the missing contracts; the reviewer needs to locate the actual definitions and initialization paths and distinguish partial inspection from evidence of absence.


## Confirmed false-positive mechanism: assumed framework semantics

Baseline r1 in Discourse PR 4 records `cook-method-default-raw-html` as P1, claiming the database default 1 selects raw_html and bypasses sanitization for all ordinary posts. It even suggests changing the default to regular=0. Frozen `lib/enum.rb:14–16` explicitly defaults the first member to **1**, so `Enum.new(:regular, :raw_html)` gives regular=1 and raw_html=2. The migration's default 1 is correct. Baseline has no captured read of lib/enum.rb; candidate captured its entire 46 lines and did not report this false alarm. This is a falsifiable, source-disproved finding rather than merely an upstream-unmatched issue. It also shows why validating replacement text against a source range is not semantic validation of a proposed fix.

The finalized baseline report retains this false alarm. The controller allows replacing a finding by ID but exposes no explicit withdrawal operation. A future proposal-verification design should support retraction with retained evidence.


## Finalized baseline Discourse r1 reliability failure

`case-015-baseline-r1` ended partial after 944,527 ms, with six findings, 28/28 file coverage, and no quality checkpoint. Its final report retains the disproved `cook-method-default-raw-html` P1 above. The trace contains 46 rejected tools, starting with record_quality at request 18 and then many unknown/rejected reporting attempts. Fifty model calls settled before request 51 failed the input-count guard. The common adapter conservatively accumulates prompt/output bytes plus generation and reserves native overhead; its count exceeded the profile guard. This is not evidence that the provider actually exhausted its context: the last settled call reported 113,001 input tokens, and the controller's error combines invalid/unavailable count with over-limit count. Here the common adapter's count implementation returns its conservative estimate synchronously. The baseline's module-identity telemetry gap prevents reconstructing its adapter count event, so avoid inventing an exact estimate.

The review did not finish simply because it had examined every file. Reporting schema rejection consumed the remaining work and retained a source-disproved finding. Both precision and completion need contract verification, informative validation feedback, and a way to retract unsupported findings; proposed changes remain outside this frozen experiment.


## Partial expression and extraction: Cal.com retry updates

Candidate r1 case-005 captured the complete changed scheduler (reads 2 and 6), both stale `retryCount + 1` writes at 184 and 195, the complete Twilio provider, and the cron workflow. Its only structured finding explains a new unguarded database update inside catch, which can abort the batch. However, its suggestion explicitly recommends an atomic increment and its patch uses increment:1. The upstream extractor expands this into a separate lost-update-concurrency candidate, which the judge matches with confidence 0.92. Therefore this is **not a raw benchmark miss**, and should not be used as proof that the model missed concurrency entirely.

The developer-facing report does not itself explain why concurrent snapshots lose increments or identify the second write as affected. This is a narrower reporting/completeness gap: an improvement in a suggested fix is not as clear as an explicit causal finding, and the extractor can infer a stronger claim than the review text actually makes. Private reasoning is not retained, so whether the model considered the full race cannot be established. Raw score retains the match.

## Positive cross-component result: Grafana 106778

Candidate r1 case-022 completes in 498,429 ms with 14/14 files reviewed, four structured findings, and both expected labels matched. It traces Prom-only data through action permissions, menu rendering, and drawer rendering; its finding explains why granted abilities do not make missing handlers work. It also identifies the lost FilterView key. This establishes that the controller can follow the relevant cross-component contract in this case, while the nullable-member and dependency-initialization examples show it does so inconsistently. Two repeats are needed before attributing stability to the change.


## Confirmed regression-attribution failure: retrying already existed

Baseline r1 case-005 reports `sms-retry-non-idempotent`, claiming the new automatic retry path introduces duplicate Twilio messages if the external create succeeds but local scheduled=true persistence fails. The entire trigger already exists at base: scheduler selects scheduled=false at39–46, creates the message at147–154, updates scheduled/referenceId at156–165, and only logs the failed update at168–169. The following cron invocation can select it again without any retry-count feature. The new counter limits eventual attempts; it does not introduce this trigger. This is a supported pre-existing risk, incorrectly attributed to the PR. It should not be counted as a new regression merely because retry-related lines changed.

A claim-verification step should compare the same concrete trigger against both revisions, not merely cite the base file or note that a new line is related to the concern. This is a third recurring mechanism alongside partially inspected dependencies and unverified framework assumptions.


## Third baseline partial: large locale coverage

Baseline r1 case-022 ends partial after 484,061 ms after 23 calls, with 13/14 files reviewed, three findings and quality retained. It reaches the same conservative input-count guard, with 7 tool rejections and126 source reads. Candidate r1 completes 14/14 in 498,429 ms. This is a completion improvement with a slightly longer elapsed attempt, not a speedup on this pairing. Baseline's known provider usage is settled; do not confuse the conservative history estimate with actual provider input tokens.


## Early repeat disagreement: Keycloak 32918

Candidate case-032 r1 reports only the disabled-organization login-cache invalidation issue; r2 reports only the expected literal-alias cleanup typo. These are distinct mechanisms. The second run can score better against sparse gold while omitting the source-supported runtime concern from the first. Report repeat agreement of annotations and the underlying structured finding mechanisms separately; neither the union of both attempts nor the better single attempt represents a one-run product result. No reviewer received audit feedback between attempts.



## Non-SMS retry deletion: additional writer audit

An independent head search for workflowReminder.update/upsert identifies the SMS scheduler, three Email scheduler updates, WhatsApp scheduling, and Email cancellation. The Email updates at81–87,290–297,346–353 change scheduled/referenceId; Email cancellation at390–396 changes cancelled; WhatsApp at101–108 changes scheduled/referenceId. None changes method or retryCount. All retryCount references in apps/packages confirm the new SMS increments, schema/migrations, and unrelated Office365 retry locals/Zapier schema. This strengthens the conclusion that the broad deletion predicate is real but a currently reachable non-SMS-above-threshold trigger has not been established. It does not prove arbitrary external SQL or aliased writes impossible; no such supported path has been demonstrated.


## First-repeat phase timing and reporting constraints

Candidate discovery median 228s; downstream assessment/fix median 60s. Aggregates: 3,752s discovery + 937s assessment = 4,689s across 15 attempts, so assessment occupies 20% of total attempt duration. Do not add separate medians to derive the full-review median. This makes early publication an evidence-backed latency hypothesis, not an accuracy fix.

Baseline 015's 46 tool rejections break down as 34 unknown tool names, 11 record_quality and 1 finish. The local Codex adapter uses a static calls-array response schema with unrestricted name strings and JSON-encoded arguments. This leaves tool-name/field conformance to later controller validation. Production API transport is different; attribute these local protocol errors separately from missed source reasoning. A future adapter experiment could constrain tool names/arguments to actual available schemas and return precise validation paths; the frozen adapter is not changed here.


## Additional second-repeat Sentry finding: filtered commit marker shape

Candidate r2 case-050 reports `thread-queue-drops-filtered-commit-markers`, outside the supplied Core docstring label. Source inspection supports the interoperability failure: consumers/dlq.py:97 explicitly says filtered messages exist so all-stale streams can still commit; its poll at133–140 creates Message(Value(FILTERED_PAYLOAD, offsets)) and clears offsets after the downstream submit returns. Consumers/__init__.py:586–589 installs this wrapper when stale_threshold_sec is set. The new queue strategy decodes before handling filtered payloads (queue_consumer.py:293–303), while decode_payload asserts against FilteredPayload. Its exception handler only recovers offsets from BrokerValue, so the real Value marker is swallowed. This is a concrete wrapper/new-strategy contract mismatch, not merely a generic request for more exception handling. No live Kafka reproduction was run.

The added invalid-message test uses FilteredPayload inside BrokerValue and therefore misses the real wrapper's Value shape. This is another example where tracing actual producers/consumers and their data shape finds more than inspecting the changed implementation and its new tests alone. The unchanged raw benchmark gives no expected-label match for this extra concern.


## Correct finding does not establish a safe fix

For candidate r2 case-050's filtered-marker finding, the suggestion says to forward message.committable directly to the commit callback (or use CommitOffsets-compatible logic). A literal direct-commit implementation needs an additional ordering guard: a valid earlier record can still be running in the asynchronous queue when a later stale-record marker arrives. DlqStaleMessages emits the marker after one second regardless of prior worker completion. Committing the marker's later offset immediately can advance past the unfinished valid record, bypassing OffsetTracker's success-ordering guarantee.

Example: valid offset 100 is enqueued and takes longer than a second; stale offset 101 produces a marker for the next offset 102; committing 102 before 100 finishes can skip 100 after a restart. The report's broad alternative could be implemented safely by respecting pending work, so this is a warning about the literal direct-commit recommendation, not proof that every proposed implementation fails. No patch was executed. Finding quality and safe-fix quality must be assessed separately; matching an expected finding or validating a replacement source range establishes neither safe commit ordering nor patch correctness.


## Final outcome of long Sentry baseline request

Case-050-baseline-r2 finishes at 14:20:15Z after 2,576,844 ms (42m57s), status partial, three calls, 14 source reads, zero accepted findings and no quality/coverage checkpoint. Last call settles 55,628 input and 633 output tokens with status incomplete. The adapter/provider failure kind remains absent because of the baseline instrumentation issue; raw stdout events were not retained, so the exact adapter rejection stage cannot be reconstructed.

Inspection of the benchmark-owned session's final public assistant message (not private reasoning) shows a valid outer calls object with eight calls. Seven calls, including four search_repository calls, validate against the registered frozen tool schemas. The record_finding arguments string is not valid JSON: it contains extra trailing data after the first object. The first object proposes failed-result offset committing as P1, but it was never accepted by the controller. This is evidence of malformed model/tool protocol output, not a scored or successfully delivered finding. It does not prove that malformed arguments caused the adapter's earlier status decision or explain the preceding long wait. The raw benchmark keeps zero accepted findings.


## Native Codex tool interface: read-only feasibility check

The current official Codex manual documents experimental dynamicTools on thread/start and item/tool/call client requests. The installed CLI's generated experimental JSON Schemas confirm inputSchema-bearing function definitions and structured arguments values, rather than an arguments string nested inside a synthetic calls response. The source inspection and schema hashes are retained in native-protocol-audit/inspection.json. No new model inference or reviewer implementation was run for this check.

This installed schema exposes dynamicTools on thread/start, but not thread/resume or turn/start. A replacement cannot simply assume the existing per-response tool inventory can be swapped unchanged. It must preserve phase authorization, controller validation, immutable source access, cancellation, checkpoint persistence and accurate usage settlement. Native arguments can remove one avoidable serialization layer; they do not establish correct findings or automatically make the integration reliable. [Official Codex manual](https://developers.openai.com/codex/codex-manual.md).


## Repeated pagination miss

Case-042's nullable member is absent from all four final finding lists (both controllers, both repeats). Candidate r2 reports the datetime arithmetic issue plus three span-buffer concerns, omitting its r1 negative-slice finding and adding root-eviction/redirect-depth concerns that have not been independently adjudicated here. Baseline r2 retains datetime/negative-slice/Redis-type findings. Thus the nullable dependency-contract miss persists, while other discovery choices vary. Do not count the newly emitted span-buffer concerns as confirmed extra defects without checking their triggers and retention/timestamp semantics.


## Candidate transport rejection with a completed CLI turn

Case-046-candidate-r2 ends partial after213346ms, two model calls, zero findings, and settled usage. Its captured provider.codex.failure reports stage native-tool-or-failed-turn, classification transport, usageKnown=true, one completed turn, and event types thread.started/turn.started/error/item.completed/turn.completed; the only item type is agent_message. The adapter explicitly rejects any error event before examining the final tool envelope. This identifies a concrete acceptance rule that needs a recovery contract, not evidence of native tool execution.

The current official noninteractive-mode documentation lists error and turn.failed/turn.completed event types but does not establish that every earlier error can safely be ignored after turn.completed. Keep the frozen rejection outcome; do not infer a valid complete review solely from the completed turn. Any later recovery change must still validate final output, session identity, authorized tool activity, and usage, retaining transient error metadata. [Codex JSON output documentation](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).


The candidate046 session's final public message was inspected separately: all eleven calls (five search_repository and six read_file) have valid JSON arguments and pass their registered frozen tool schemas. The batch was not accepted after the adapter's transport-error decision. This is a valid next investigation step lost at the transport boundary, not proof of a completed review or a correct finding. An earlier audit draft incorrectly called repository search unsupported; direct imports of both frozen controllers confirm it already exists. The validation artifact is native-protocol-audit/public-final-validation.json. Error-event recovery needs a documented terminal-state contract and retained sanitized error metadata; do not silently ignore every error event.


## Full-report extraction example: case-006 baseline repeat 2

The structured result records zero findings. Upstream extraction nevertheless creates six candidates: five related testing concerns from the quality rationale, plus the controller-generated statement that required validation has not run. All six remain unmatched. This directly demonstrates that the raw precision denominator is not a count of developer-facing bug findings. It does not prove all five testing concerns are invalid. Keep the pinned full-report result; a future separately labeled findings-only diagnostic should isolate discovery from report extraction and must not silently replace the comparable score.

The report also says no production caller was found. Independent `git grep` for `InsightsBookingService` across TypeScript/TSX at both frozen base and head returns only the service and its integration test. This corrects an earlier audit draft that incorrectly called the service newly introduced; the PR refactors an existing service. Static identifier search does not rule out every dynamic invocation.


## Pinned CLI error semantics: why the native interface is worth testing

The installed CLI is 0.145.0. Its matching upstream [JSONL processor](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L434) maps every app-server Error notification to a top-level `error` containing only a message; this branch does not inspect or preserve `willRetry`. Its [completion branch](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L513) separately emits `turn.completed` when the turn status is Completed. The locally generated matching app-server ErrorNotification schema retains `willRetry`, thread/turn IDs, and typed error information.

This explains an interface ambiguity: the JSONL event definitions call top-level errors unrecoverable, but the processor drops the upstream retry distinction. Our adapter treats the mere presence of any such error as fatal even when the CLI later completes the turn. Candidate046 is an observed discarded schema-valid batch after an error plus completed turn; the original retry flag was not retained, so this audit cannot recover that flag or prove the precise underlying error.

A native app-server transport experiment can preserve that distinction and the terminal turn state, without weakening controller authority or automatically replaying failed reviews. It should handle transient errors, terminal failures, cancellation, native-tool rejection and usage accounting explicitly. Dynamic tool registration would separately remove the nested JSON-string argument envelope. These are proposed changes, not patches to this frozen experiment. The three pinned upstream source files and generated protocol schemas are retained under `native-protocol-audit/`.


## Implemented follow-up, excluded from this experiment

Commit `3385130` makes a narrow terminal-state correction in the local benchmark adapter. An earlier top-level error no longer automatically discards a later completed turn. Acceptance still requires successful process exit, valid event JSON, no failed turn or forbidden native item, the expected session identity, exactly one completed turn with valid nondecreasing usage, a valid outer tool batch, and no error after completion. The ordinary controller still validates each tool and its arguments before execution. Recovered error counts are traced without message content.

The regression check reproduced the previous partial result and then completed the same fixture review across three turns after the fix. Rejection checks retain zero accepted evidence and known usage for native tool use, malformed final output, invalid session identity, error after completion and failed-turn events. An error without completion still fails. All six adapter checks and four benchmark harness/summary/entrypoint checks pass. This is an offline adapter fix, not evidence of improved live benchmark recall or completion. No frozen attempt is replayed or rescored. A native app-server migration remains a separate future experiment rather than a prerequisite for this correction.


## Independent controller coverage regression

An offline synthetic fixture exposed a separate bookkeeping defect in r02-26: a 20,002-byte source line passes the raw 24 KB read limit, but JSON escaping expands its text to 40,004 bytes. The read branch checkpointed source evidence before the common 32 KB output guard rejected the response. A later discovery-complete call could therefore accept coverage from a rejected read. The original reproduction is retained in `controller-output-audit/result.json`. This violates the source-tool evidence contract; the diff can still contain the text, and required validation/rating gates remain separate. No live paired attempt has been attributed to this defect.

Commit `b00bc22` (r02-27) validates encoded read size before tracing or checkpointing the read. The regression test proves that only the successful base read is recorded, the head range remains missing, and a complete-discovery request is rejected. The full isolated review suite passes: 193 tests passed, one Linux-only execution test skipped on macOS. The primary workspace also passes the targeted check. No target application or external model was executed for this fixture. The frozen r02-26 comparison is unchanged.


## Baseline case-015 repeat 2: latency-triggered early reporting

This attempt ended partial with `stopReason=finished` after 2,412,104 ms (40m12s), with one finding, quality recorded, 16 source reads, 10/28 files reviewed, and fully settled usage. Its second model request took 2,332,882 ms (38m53s). The next request still had 1,226,858 ms (20m27s) of deadline allowance, but the largest-response timing heuristic reserved 1,800,000 ms for reporting and exposed only `finish`. The model explicitly reported unresolved source inspection.

This is an early reporting decision after an extreme latency spike, not an incomplete provider response: the final model call completed. The maximum-observed-request heuristic can turn one slow response into loss of the remaining inspection window. A future budget-policy experiment should distinguish ordinary reporting needs from exceptional provider latency. This run retains the original heuristic and partial result. The raw-feed-HTML finding from this attempt has not been independently adjudicated here.


## Final repeat checks

Candidate case-015 captured head lines 1–30 of `app/views/embed/best.html.erb` in both repeats, but the ERB syntax annotation remains a false negative in both final grades. This is a repeated omission after a successful source read, not the separate oversized-read fixture defect.

Baseline case-022 repeat 2 ended partial after 353,351 ms with the input-count guard, 19 model calls, 202 tools, 13 rejections, three findings and 13/14 file coverage. Its last settled call reports 226,214 input tokens and 783 output tokens; no provider failure was recorded. It matches one Core annotation. Candidate matches both Core annotations in both repeats.

Final totals are 53 complete and seven partial attempts, with all 60 graded. Each arm matches 27/72 Core opportunities. The candidate completes 29/30 versus baseline 24/30, but has lower raw Core F2 (0.303 versus 0.316). The source audit does not replace those counts with a more favorable score.
