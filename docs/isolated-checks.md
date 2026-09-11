# Isolated checks on the review worker

The optional Linux worker executes operator-configured commands on the captured
PR head, then on each proposed patch separately. It uses the existing review
host and API provider. No subscription login or provider credential is exposed
to repository code. This is review-owned execution on a configured host; it is
not yet automatic discovery, pairing, or scheduling through managed atmin Boxes.

Enable checks in the operator's pilot configuration, scoped to a numeric GitHub
repository ID. Commands are never taken from model output or PR instructions:

```json
"localChecks": [
  {
    "repositoryId": 123456,
    "name": "ownership",
    "argv": ["node", "--test", "test/ownership.test.mjs"]
  }
]
```

Add `ownership` to `requiredChecks` in `.atmin/review.json` on the target branch
to enable that command and make it affect the GitHub check. A local name must not overlap a trusted
GitHub CI name. There is no model-triggered shell, dependency installation, or
fallback to execution outside the sandbox. Configure only commands supported
by the runtime installed on the worker.

## Boundary and limits

The host requires Linux and `bwrap` with usable namespaces. Each execution has
an empty filesystem populated with read-only `/usr`, the Node runtime, and its
checkout; private process, network, IPC and UTS namespaces; no inherited
credentials; no `/proc` mount, a private `/dev`; and 64 MiB of disposable `/tmp`.
The repository is read-only during execution. Commands needing writable source,
network access, absent dependencies or additional host mounts cannot pass.

Checkouts contain exact Git blob contents, without Git configuration, hooks or
object metadata. Symlinks and submodules are rejected. Limits are 2,000 files,
20 MiB of source, five configured checks, 30 seconds and 64 KiB of output per
execution. At most three patches are checked independently. Each starts from
the same head; fixes are not combined. The pilot service's existing memory,
CPU and task limits also apply. This remains a shared-kernel private pilot,
not a hardened public multi-tenant compute service.

## Evidence

`verification.json` is controller-owned and separate from model-authored
`result.json`. It records head/target identity, named head check results, and
results bound to each exact file/range/original/replacement digest. Changed
commits or modified patches cannot reuse a passing observation. Raw process
output stays out of comments and dashboard responses.

Head results affect required validation. Patch results describe only that
proposal and never turn a failing head into a passing PR. Reports and native
GitHub suggestions show the observed check status. A recorded failing patch check
withholds the native apply button while retaining the finding and attempted
replacement in the full report. Passing tests are evidence,
not proof of correctness. Missing/unsupported execution never implies a pass.
The dashboard shows the actual stored code replacement and any matching check
results. Accepting a suggestion remains a GitHub action that creates a new head.

The reviewer still reasons over source through bounded API calls. The worker
runs verification after investigation; it does not yet feed test output into an
iterative model repair loop. Native managed-Box scheduling belongs in a later
integration using the environments system's public contracts.

## Verify a Linux worker

Run `ATMIN_REVIEW_VERIFY_LINUX=1 node --test test/verification.test.mjs` after
building. This is an explicit integration test because ordinary source-review
installations do not require Linux namespaces or Bubblewrap. The test must pass
under the worker's actual service restrictions before enabling local checks.
The provided systemd unit permits AF_NETLINK so Bubblewrap can initialize the
private network namespace. It does not mount `/proc`, avoiding exposure of host
process information and preserving the service's kernel protections.
