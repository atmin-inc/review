# Minimal GitHub fixes

Current source can attach a minimal code replacement to an inline GitHub finding.
The reviewer first records the finding, then optionally calls `propose_fix`.
The controller verifies the original text against the immutable head and requires
cited source reads covering the entire range. Publication requires the same text
in one current diff hunk. GitHub provides **Apply suggestion** and batching;
atmin never commits the patch automatically or requests Contents write access.
The resulting commit follows normal PR review triggers and configured limits.

P0–P4 findings can have a proposed fix; severity is independent of confidence in
the fix. Proposals are **not executed or tested** unless the operator enables the
[isolated worker](./isolated-checks.md); matching fix check results are shown
separately. Invalid or unavailable proposals leave the finding as ordinary feedback.
The first version supports one head-side replacement per finding, up to 20 lines
and 4,000 characters on each side. It omits overlapping suggestions, ranges across
diff hunks, CRLF/control characters, Markdown fences and files marked without a
final newline. Coordinated multi-file fixes remain explanatory advice.

Acceptance checks cover proposal recording and rejection, immutable-source
revalidation, GitHub ranges, overlapping edits, injection-resistant formatting,
and a deterministic ownership regression fixed by applying the proposed patch.
These establish workflow behavior, not model fix accuracy.


The proposal tool rejects stripped indentation on an otherwise unchanged first
line and asks the model to preserve it. It never silently rewrites generated code.
The summary shows the actual stored original and proposed source; eligible inline
suggestions expose GitHub's Apply suggestion and Commit changes controls.
A live generated ownership fix was published and passed three regression checks
when applied to its captured head in a disposable checkout. This does not mean
other generated fixes have been executed or tested.

The proposal tool requires the exact original text as well as its line range.
A mismatch is rejected with feedback so a miscounted line cannot silently replace
unrelated source. A failing isolated patch check suppresses the native GitHub
apply button; the finding and attempted replacement remain visible for inspection.
Replacement code is supplied to the proposal tool as an array of lines. The
controller inserts line breaks without decoding escape sequences inside code.
