# Local DAST against the shipped proxy

**Spec ID**: security/local-dast
**Status**: draft
**Last updated**: 2026-10-04
**Roadmap**: MR21
**Parent requirement**:
`specs/graph/M-masterpiece-standard.md` REQ-M27 / AC-M27.1.

## Scope

This specification defines the complete weekly/manual local DAST job: the real
shipped personal-mode proxy, a synthetic local provider, pinned nuclei and ZAP
baseline scans, truthful completion/finding gates, detector controls, artifacts
and cleanup. It does not approve the whole masterpiece draft, change Workflow or
hooks, or use a paid model. Delivery follows Decision 12's CI-infrastructure
route, including tests-first implementation and independent review.

The supported CI platform is Linux/amd64 on `ubuntu-24.04`. Separately identified
Linux/arm64 local evidence does not stand for an AMD64 CI run. Coverage is the
unauthenticated personal-mode surface actually reached. Commercial/tenant APIs,
database persistence, erasure, streaming and unreached operations are excluded.
The existing truthful pentest-MCP scoping disclaimers remain; no unenforced
role gate is claimed.

## REQ-1 (Ubiquitous): scheduled delivery and pinned preparation

**Enforced by:** test:tests/ci/dast-source-identity.test.mjs; test:tests/ci/dast-workflow.test.mjs; job:.github/workflows/dast.yml#dast
THE SYSTEM SHALL provide `.github/workflows/dast.yml` with a weekly schedule,
`workflow_dispatch`, read-only repository permissions and a 20-minute job timeout.
It SHALL have no PR trigger and SHALL NOT become a required PR context.

Before isolation, THE SYSTEM SHALL acquire and verify the fixed tool, template,
image and locked dependency inputs. Mutable tags are discovery references only.
The selected platform pins are:

| Input | Linux/amd64 | Linux/arm64 local prerequisite |
| --- | --- | --- |
| Official Node 24.21.0 / 24-bookworm image | `node@sha256:5a750d3be5e5c80275f8c9a5367c3aed99c2875656590c8d0701c7ee687f5f0a` | `node@sha256:91882e0e5959240d4413fc42c180022bbdd09c5491e00e75faa6c100d8d7751b` |
| Official ZAP 2.17.0 image | `ghcr.io/zaproxy/zaproxy@sha256:71db37cd5b75663b35758d10aaec05bf6fbac23f5020e3046c70e628a5f84efa` | `ghcr.io/zaproxy/zaproxy@sha256:05cbf4cab5d2fdaef55b0cd0b586f22d0ce4f75e0995f3cea2db23afbbdfd2f8` |
| nuclei 3.11.1 Linux zip SHA256 | `ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6` | `8044e3d9768ba0a744b2872c1a87e813006f013da97ca9f50f7661a4203bec07` |

The nuclei source identity is `a8c88feb4a1c8e961b7902534ce3af97e9d524a4`.
The two unmodified HTTP templates are `laravel-env` and `git-config`, from
`projectdiscovery/nuclei-templates` commit
`893122ffce8ebf8e264f15d2cd3960cb1dd36d6c`; bind their exact bytes and attribution.
Vendor only `scripts/dast/vendor/nuclei-templates/http/exposures/configs/laravel-env.yaml`,
`http/exposures/configs/git-config.yaml`, `.nuclei-ignore`, the complete unchanged
MIT `LICENSE.md`, and `UPSTREAM.json` under that same vendor root. Preserve
upstream bytes, attribution/signature comments and license; UPSTREAM records
commit/path/blob/size/SHA. Required package/source inclusion SHALL retain all
five files. Never scan the directory as an implicit template set.
Stage that commit's unchanged `.nuclei-ignore` (SHA256
`699053f709b11e80d853b63ebdcfe7ea0b15464f7d9709379c71bb12a41c627b`)
in a fresh owned `NUCLEI_CONFIG_DIR`; it excludes neither selected template/tag.
No latest-version, remote-template or addon discovery occurs during scanning.

The prerequisite allowlist change SHALL add only these five observed artifact
hosts to the existing GitHub/release-assets/npm preparation hosts:
`ghcr.io`, `registry-1.docker.io`, `auth.docker.io`,
`pkg-containers.githubusercontent.com`, `production.cloudfront.docker.com`.
For owned HTTP artifact/manifest downloads, reject unreviewed redirects,
non-HTTPS, userinfo and unexpected ports; preserve digest/size verification across
redirects without forwarding bearer credentials to another authority. Docker
image pulls are trusted host-daemon provisioning by exact platform digest using
an empty owned CLI configuration; the CLI does not expose or enforce the
daemon's redirect chain. Verify the inspected descriptor, platform, Config and
RootFS against the retained manifest/config, and bind container.Image to the
observed engine image ID rather than assuming it is the config digest. Do not
claim the HTTP downloader mediates Docker or npm traffic. Locked runtime npm
preparation SHALL use fresh configs/cache and disable install scripts, including
only the required Linux architecture's locked native dependencies; a registry
setting is not an OS firewall. Anonymous registry tokens SHALL remain transient and
absent from artifacts/workload containers. No wildcard hosts, saved operator
login, operator data or provider/database credentials are admitted. This text
allowlist is not the workload's network firewall.

## REQ-2 (Unwanted behavior): reject an unowned target before launch

**Enforced by:** test:tests/ci/dast-target.test.mjs
WHEN `scripts/validate-dast-target.mjs` runs, THE SYSTEM SHALL accept no arguments
and return 0 only when `DAST_TARGET` is exactly
`http://127.0.0.1:18080/docs`. All other values, including absent/empty, external,
credential-bearing, alternate-host/IPv6/port/path, encoded, whitespace, query or
fragment forms, SHALL fail with a fixed diagnostic that omits the input.

The standalone validator SHALL emit exactly `dast-target: accepted\n` to stdout
and exit0 for admission, with empty stderr. Every refusal SHALL exit1, emit only
`dast-target: refused\n` to stderr and leave stdout empty. The validator SHALL
not inherit a target fallback or emit the refused value.

The runner SHALL apply that admission before container/scanner launch and bind
it to the owned proxy. Nuclei SHALL use only the same fixed origin
`http://127.0.0.1:18080`, because its templates append root-relative paths.
The production job SHALL accept no arbitrary command, target or template
override. A detector-control fixture may use that address only in its separately
owned namespace; its evidence SHALL remain distinct from the application run.

## REQ-3 (State-driven): enforce isolated loopback execution

**Enforced by:** test:tests/ci/dast-reports.test.mjs; test:tests/ci/dast-owned-run.test.mjs
WHILE a target or scanner runs, THE SYSTEM SHALL use a fresh Docker namespace
created by an owned `--network none` anchor. Other scanner containers SHALL join
only `--network container:<recorded-anchor-id>`. The proxy/provider/ZAP listeners
SHALL use `127.0.0.1` ports 18080/18081/18090. Any additional tool listener,
including nuclei statistics, SHALL have a source-bound, observed address/port
in the prerequisite inventory and SHALL NOT be an allowed scan target.
Request nuclei metrics at `127.0.0.1:18091` and refuse an observed fallback port;
the pinned statistics library can choose a random loopback port on collision.

Workloads SHALL use UID/GID1000:1000, dropped capabilities and
no-new-privileges, with no published ports, bridge/veth attachment, host network,
Docker socket, privileged mode, extra-host routing or network-changing authority.
Require cap_drop exactly ALL and cap_add, devices, device_requests,
device_cgroup_rules and volumes_from absent/null/empty; nonempty values fail.
Use the fixed mount/isolation projection in Annex A, including readonly sources
and separate dynamic run identity. No implicit inherited Docker attachment is
accepted.
Before scanning, observe matching namespace/container identities, only loopback
active/addressed under the finite policy below, allowed mounts/capabilities,
and successful same-namespace loopback communication. Missing evidence SHALL fail without a
host-network fallback. No unowned host/bridge service is probed. The host Docker
client is trusted provisioning authority outside this workload boundary.

Enumerate actual interfaces using `if_nameindex`. Require `lo`; other interfaces
may only be optional members of this observed table satisfying every predicate:

| Name | ARPHRD type | ioctl/sysfs flags | Zero link-address bytes |
| --- | ---: | ---: | ---: |
| tunl0 | 768 | 0x80 | 4 |
| gre0 | 778 | 0x80 | 4 |
| gretap0 | 1 | 0x1002 | 6 |
| erspan0 | 1 | 0x1002 | 6 |
| ip_vti0 | 768 | 0x80 | 4 |
| ip6_vti0 | 769 | 0x80 | 16 |
| sit0 | 776 | 0x80 | 4 |
| ip6tnl0 | 769 | 0x80 | 16 |
| ip6gre0 | 823 | 0x80 | 16 |

Each optional device SHALL have matching positive interface/sysfs index, iflink0,
exact table type/flags, operstate down, neither UP nor RUNNING, the specified
zero link address, absent primary IPv4 with EADDRNOTAVAIL, no IPv6 address and no
referring route. For lo require type772, ioctl flags0x49, sysfs flags0x9, iflink
equal to index, operstate unknown, six zero link bytes, IPv4 127.0.0.1 and only
optional ::1/128 IPv6. Reject other address records. `bonding_masters` is the only
optional non-interface sysfs entry admitted; never count it as an interface.

Require an empty IPv4 route table; IPv6 routes must use lo, zero source/next-hop,
and only ::1/128 flags0x80200001 or ::/0 flags0x00200200. Retain raw route bodies
and counters. Require nonempty parsed IPv4 FIB evidence entirely within127/8,
CapInh/CapPrm/CapEff/CapBnd/CapAmb all0, NoNewPrivs1, and all four UID values1000.
Unexpected evidence fails closed. No name-only skip, generic inactive-device
allowance, or interface/route/privilege mutation is permitted. Namespace inodes
can be reused after container removal; bind runs with owned container IDs and
source/artifact identities rather than inode equality alone.

## REQ-4 (Event-driven): measure the unchanged real application

**Enforced by:** test:tests/ci/dast-supervisor.test.mjs; test:tests/ci/dast-reports.test.mjs
WHEN the run starts, THE SYSTEM SHALL launch `runtime/src/proxy/index.ts` through
locked tsx with named, read-only runtime source/dependencies/package/tsconfig
inputs and the required root `observability/pii-redaction.ts` import. It SHALL
use fresh synthetic capture/scratch directories and a constructed environment,
excluding inherited provider, database, proxy, loader and activation settings.
Do not replace routes, inject testing dependencies, use `app.inject`, mount the
working checkout or modify production behavior for the scan.

Use one bounded local OpenAI-shaped stub at port 18081, with no URL forwarding,
filesystem lookup, model or external service. It SHALL return the fixed synthetic
non-streaming answer/usage for the selected readiness request and reject
unexpected authorization, method/path or malformed input. Before and after
each scanner, require a live tracked proxy, correct real `/health`, and a genuine
`/v1/messages` round trip with the expected answer, usage and provider-counter
delta. Initial readiness SHALL also establish `/docs`, `/openapi.json`,
`/dashboard`, `/dashboard/graph` and the same synthetic capture in `/dashboard/api`.
Keep Host/CORS/rate-limit guards. Readiness requests are not scanner coverage.

## REQ-5 (Ubiquitous): complete the actual nuclei scan

**Enforced by:** test:tests/ci/dast-reports.test.mjs; job:.github/workflows/dast.yml#dast
THE SYSTEM SHALL run the verified nuclei binary with only the two pinned HTTP
templates, fresh config/home, updates/OAST/redirects/cloud upload disabled and
finite concurrency, request rate, timeout/retries and outer deadline. No code,
file, headless, AI or automatic-template mode SHALL be enabled. Preserve the
actual terminal state, JSONL findings, final JSON statistics and request-error
log in fresh owned paths. Offline cold-home/template startup SHALL be a verified
prerequisite; `-version` success alone does not establish it.
Use `-duc` and the fixed owned config/home/cache paths. The pinned source places
fresh template installation and update checks behind that disabled branch; it
still initializes local configuration. A real scan SHALL verify the staged
ignore-file and template path behavior because `-validate` skips the ignore read.

The fixed launch flags SHALL retain `-pt http -duc -ni -dr -nc -j -or -ot`,
`-rl 10 -c 1 -bs 1 -timeout 5 -retries 0`, the two explicit template paths,
owned output/error paths and the statistics options below. No caller flag is
appended. Success SHALL require exit 0 without signal/deadline, exactly two loaded templates,
one host, positive completed engine request/total counters and zero errors.
These are accounted engine units, not a measured HTTP request count: the pinned
parallel engine increments when scheduling a generated job. The observed cold
probe had23 completed units and21 real fixture requests. Preserve both measures
separately; no claim that all23 reached the application is allowed. Fixture
controls SHALL observe actual requests for both selected paths; application
readiness and ZAP URL inventory SHALL remain separately labelled.

For the fixed `-stats -sj -si -1 -mp18091` configuration, require two final JSON
statistics records in stderr: enumeration completion and subsequent runner Close
both print a snapshot. Require identical templates/hosts/matched/requests/total/
errors/percent/startedAt between them; duration/rps may differ. The eight numeric
fields are decimal strings; require templates2, hosts1, positive requests equal
total, errors0 and percent100. Require valid startedAt/duration fields and an
empty request-error log. Never GET `/metrics`, which prints another snapshot. Missing
statistics, unloaded templates, incomplete counts or error output fail. A genuine
zero-byte findings JSONL is valid only with that completion evidence; a missing
file never is. Require each final matched counter to equal the parsed JSONL
record count, including0 for an actual empty file. The pinned ordinary HTTP
writer increments matched per nonsuppressed result; failed writes cannot justify
fewer retained records. Do not fabricate a report or infer measured counts from template
metadata. This is a finite configuration-exposure scan, not all nuclei templates.

## REQ-6 (Ubiquitous): complete the actual ZAP baseline before reporting

**Enforced by:** test:tests/ci/dast-hook.test.mjs; test:tests/ci/dast-reports.test.mjs; job:.github/workflows/dast.yml#dast
THE SYSTEM SHALL run the official pinned image's traditional baseline using
`--autooff`, target `http://127.0.0.1:18080/docs`, `-P 18090`, `-m 1`, `-T 3`,
`-J zap.json`, and source-fixed `-z` options containing `-silent -Xmx512m` plus
the four literal configuration pairs below and the fixed read-only completion
hook `/dast/zap-completion.py`. The hook SHALL read identity/kind from the exact
readonly `/dast/run.json` asset defined in Annex A, validate its small schema and
use no environment run-ID or default kind. Its expected live listener set is
18080/18081/18090 for application and18080/18090 for positive_control. Fixed
self-hashing SHALL read `/dast/zap-completion.py`, without relying on `__file__`
which the upstream ModuleType loader does not initialize. Appending a duplicate `-host` does not override this image's initial
wildcard host. Generate a copy of its exact `zap_common.py` (SHA256
`a1f65469bdee238424d2c32bbe15345ba3fb7089baf9800fbe72f20fa88c72c0`)
with only the first host literal inside `create_start_options` changed from
`0.0.0.0` to `127.0.0.1`; require the anchored occurrence and inverse-diff proof,
preserve its Apache2 copyright/license header, and require modified SHA256
`fe62f7abb3a9ef75bbf0f5edc49fa9d276607262fc8436fa87050745ec9cd361`.
Mount that derivative read-only over `/zap/zap_common.py`. No scanner, spider,
queue, report or exit behavior may be patched. Disable only the auxiliary
OAST/HUD lifecycles through core extension options:

```text
-config extensions.extension(0).name=ExtensionOast
-config extensions.extension(0).enabled=false
-config extensions.extension(1).name=ExtensionHUD
-config extensions.extension(1).enabled=false
```

Observe exactly the permitted effective loopback listeners; accept IPv4-mapped
IPv6 representation of the same127.0.0.1 address. Unexpected or wildcard
listeners fail. Preserve the passive engine0.6.0/rules75.0.0 inventory and enabled
rule10062; no passive rule/threshold is disabled to obtain a passing launch.
The heap cap SHALL fit the separate container memory limit. Preserve the
image's shipped configuration/disposable writable layer; mount only the owned
report directory writable at `/zap/wrk`. No plan-only, modern/AJAX/Client Spider,
active scan, external config, suppression/progress waiver or caller hook is allowed.

The fixed `zap_get_alerts` pre-hook SHALL observe a zero passive queue before
alert collection/report generation, preserve all four arguments unchanged and
record a before-report witness. The fixed `zap_pre_shutdown` hook SHALL again
observe zero queue and record that witness, nonempty same-origin URL inventory
and active passive-rule inventory after the completed spider. Hooks SHALL NOT
alter scanner policy, suppress findings, issue scan requests or replace baseline
execution. Missing witness/receipt, nonzero queue, no scoped URLs/rules, outer
timeout, signal or status outside 0/2 SHALL fail. Zero URLs skip the upstream
alert hook and therefore cannot satisfy completion. Status 2 still requires
severity inspection under REQ-7.

The baseline accesses `/docs` then spiders origin `/`; preserve observed `/docs`
access and actual coverage. Do not claim it retained the seed path or exercised
the client-rendered/POST operations. A final queue check alone cannot authorize
an earlier report: upstream passive timeout can return without failing.

## REQ-7 (Unwanted behavior): fail closed on findings or incomplete evidence

**Enforced by:** test:tests/ci/dast-reports.test.mjs
WHEN judging a run, THE SYSTEM SHALL read only its fresh owned regular report
files, reject symlink/path redirection, and enforce strict UTF-8/JSON and bounded
input: 10 MiB per scanner report, 2 MiB per diagnostic stream, 256 KiB per
completion receipt and at most 4096 URLs. Validate required fields/types before
counting. Oversize, malformed, stale or missing evidence SHALL fail without
truncating it into success. Bind run/target, source/tool/template identities,
timestamps, health, actual terminal states and report hashes in one summary.

Nuclei records SHALL name an expected HTTP template and exact target origin;
require the pinned mapping `laravel-env`→`high`, `git-config`→`medium`. Unknown
or mismatched severities SHALL refuse, never downgrade a finding. Output count
keys remain `info`, `low`, `medium`, `high`, `critical`. ZAP
traditional JSON SHALL contain the single target site, valid alert/instance
arrays and string risk codes `0`/`1`/`2`/`3`; every instance/coverage URL SHALL
have that target origin. Reject foreign/provider/scanner origins or unknown
severity rather than silently discarding them. ZAP risk 3 and nuclei high/critical
SHALL fail; lower findings remain visible/countable. ZAP has no separate critical
category. Annex A freezes the observed pinned report shape and completion wire.

Only a complete, healthy, correctly bound run without high/critical findings
SHALL return 0 and `PASS`. Every failure SHALL return nonzero and
`INDETERMINATE`, with a distinct reason. A completed scan with a high finding
SHALL retain `scan_complete: true` and actual counts; the red readiness verdict
does not erase that observation. Console diagnostics SHALL be bounded and
JSON-escaped, without raw report/input bodies or terminal-control injection.

## REQ-8 (Event-driven): prove detection and refusal

**Enforced by:** PROCESS
**Enforcement note:** Actual pinned detector-positive runs are acceptance observations; synthetic report tests alone do not establish detection.
WHEN accepting this implementation, THE SYSTEM SHALL run both actual pinned
scanners against a separately isolated synthetic detector fixture and observe
their expected high findings and the real gate's nonzero verdict. The nuclei
control serves non-HTML `APP_NAME=MR21_SYNTHETIC_CONTROL` at `/.env` and a synthetic
`[core]` body at `/.git/config`; require the selected high and medium detections.
It contains no secret and reads no file. The ZAP control uses labelled synthetic
HTML test data detected by the observed passive rule10062 at risk3. Preserve the
fixed observed control bytes in `tests/fixtures/dast-positive-target.mjs`; no
actual personal/card data is used. Controls share the same fixed scanner/report
policy but remain separate fresh namespaces and kind=positive_control.

Then run both scanners against the unchanged shipped proxy under REQ-2–7.
Never substitute detector-fixture findings for application evidence, weaken
detectors to obtain success, or replace actual integration witnesses with fake
tools/handwritten reports. Finite negative controls SHALL cover external target,
absent/dead proxy/provider, missing nuclei report, malformed/stale/oversized
evidence, unknown severity/foreign origin, absent/unfinished completion witness,
tool error/signal/deadline and failed post-health.

## REQ-9 (Event-driven): preserve evidence and clean owned resources

**Enforced by:** test:tests/ci/dast-owned-run.test.mjs; test:tests/ci/dast-workflow.test.mjs; job:.github/workflows/dast.yml#dast
WHEN any run terminates, THE SYSTEM SHALL export bounded synthetic reports,
logs, bindings, statuses, health/completion evidence and summary to owned host
paths before resource removal. A finally path independent of upload success
SHALL stop scanners, SIGTERM/drain the tracked proxy under a bounded deadline,
stop the provider and remove only recorded owned containers/volumes/scratch.
No global prune, process-name kill, operator-stack reset or existing-data cleanup.
Cleanup failure SHALL remain visible. Artifact upload SHALL run with an always
condition, fail on required missing files and preserve earlier failures.

Source/tests/required checks/independent review gate merge. After default-branch
registration makes dispatch available, an actual successful dispatch SHALL run
both scanners against the app and upload both reports before MR21 is complete.

## Fixed product surface and execution budgets

THE SYSTEM SHALL implement only the following named delivery surface for this
scope. Annex A fixes the report and isolation formats; Annex B fixes the internal
supervisor protocol. They are normative parts of REQ-1–9. No ignored state file
is a product runtime dependency.

| Path | Responsibility |
| --- | --- |
| `scripts/validate-dast-target.mjs` | Standalone exact target admission; no arguments |
| `scripts/prepare-dast.mjs` | Verified online preparation and narrow immutable source/dependency stage |
| `scripts/run-dast.mjs` | No-argument production orchestration; application only |
| `scripts/dast/owned-run.mjs` | One bounded process/Docker owner, durable create intent, exact cleanup |
| `scripts/dast/proxy.mjs` | Real app/provider/Nuclei ownership and fixed private phase protocol |
| `scripts/dast/nuclei.mjs` | Fixed binary launch, actual metrics observation and bounded terminal capture |
| `scripts/dast/zap-completion.py` | Fixed before-report and final passive-completion callbacks |
| `scripts/dast/inspect-network.py` | Read-only bounded native namespace/proc/ioctl evidence collection |
| `scripts/dast/isolation.mjs` | Shared pure validation of the collected finite isolation wire |
| `scripts/dast/report-inputs.mjs` | Shared contained reader and pure native report validators |
| `scripts/dast/policy.json` | Single fixed tool/template identity policy, never caller commands |
| `scripts/assert-dast-reports.mjs` | Read-only one-directory CLI; safe verdict on stdout |
| `scripts/dast/vendor/nuclei-templates/` | Only the five fixed template/ignore/license/provenance files above |
| `tests/fixtures/dast-positive-target.mjs` | Labelled synthetic detector target, never a production route |
| `.github/workflows/dast.yml` | Weekly/manual preparation→runner→always upload, no new required PR context |

Both workloads SHALL use 1536 MiB memory, 2 CPU and 256 PID limits. ZAP Java heap is
512MiB. The production runner SHALL have a 600s overall execution deadline,
leaving cleanup independent of scan success; the ZAP baseline subprocess has a
270s outer deadline. Nuclei has45s plus bounded drain; Annex B preserves exact
startup/health/control/drain deadlines. Individual bounded Docker control calls
have20s limits, with fixed acquisition or scan operations using their explicit
larger bounds; terminate then force-stop only tracked owned children when a
terminal deadline expires. Limit captured report and stream bytes by Annex A;
never silently truncate successful evidence. Host job timeout remains 20 minutes.
These are fixed operational limits, not claims that prior prerequisite timing
establishes worst-case execution time. Resource-limit failures remain failures.

## Acceptance criteria

| AC | Given / when / then | Requirements |
| --- | --- | --- |
| AC-1 | Given the workflow, static inspection confirms weekly/manual only, read-only permissions, finite bounds, exact pins/hosts, unchanged required PR contexts and always artifact handling. | 1, 9 |
| AC-2 | Given exact target, validator passes; given `https://example.com` or another unowned form/argument, it fails without echoing input and runner records no launch. | 2; AC-M27.1 |
| AC-3 | Given the owned namespace, real loopback works, only lo is active/addressed and optional fallback devices satisfy every REQ-3 predicate; missing/incorrect identities/interfaces/routes/FIB/caps/mounts fail without fallback, unowned probes or network mutation. | 3 |
| AC-4 | Given real entry/stub, actual pre/post messages, usage/counters, health and synthetic capture pass; absent/dead target/provider fails. Annex B framing/phase admission refuses malformed, duplicate and out-of-order work; drain cancels busy work without replay. | 4; AC-M27.1 |
| AC-5 | Given actual nuclei and two pinned templates, offline scan completes; a genuine empty findings file passes only with validated complete statistics. | 5 |
| AC-6 | Given absent report, incomplete/invalid statistics, request error or failed nuclei, gate is red even if another report exists. | 5, 7; AC-M27.1 |
| AC-7 | Given actual ZAP baseline, observed seed/URLs/rules and before-report/final zero queues support completion; warning exit2 is still severity-checked. | 6, 7 |
| AC-8 | Given nonzero queue before report then zero at shutdown, or no before-report witness, gate fails despite an otherwise valid report/status0 or2. | 6 |
| AC-9 | Given each real detector control, its expected high finding is observed and the actual report gate rejects it; controls remain distinct from app evidence. | 8 |
| AC-10 | Given finite report mutations and matched-record equality, preserve genuine Git medium and ZAP risk0/1/2 counts; reject high/critical, unknown types/severities, foreign/stale/oversized/redirected input with bounded diagnostics and no input mutation. | 7 |
| AC-11 | Given startup/scan/post-health/upload failure, evidence survives and cleanup remains scoped/independent; cleanup cannot turn failure into PASS. | 9 |
| AC-12 | Given workflow registration after merge, actual dispatch executes both app scans and uploads complete evidence before reporting MR21 completion. | 1, 9; roadmap21 |

## Verification status

Observed acceptance on 2026-10-04: tests-first commits preceded implementation;
the final root suite passed 1199 tests with 0 failures and 17 expected skips.
Actual ARM64 detector controls produced the required Nuclei high/medium and
ZAP 10062 high findings and were correctly rejected. The unchanged ARM64
application passed the report, isolation, health and owned cleanup gates.

[PR #239](https://github.com/MILTONADINA/DevOPs/pull/239) passed all six required
checks and merged an equal tested tree. Actual default-branch
[dispatch 37193372293](https://github.com/MILTONADINA/DevOPs/actions/runs/37193372293),
attempt 1 at `cf7658df7a95c08746003dd7d1d072cf1f370226`, then passed on Linux/amd64.
Artifact 11299423835 contains both native reports and has SHA-256
`8f19169a5bd758865c1b13715e67c87902b580819e5d468c3815cffcb3ab87be`, matching the
downloaded archive. The checker copied from the dispatched commit accepted its
application run `mr21-dast-e8cca75060df01f45b24714ba7836f77`: complete reports,
five real health/provider/capture rounds, zero Nuclei findings and ZAP high0/medium2/low1.
Preparation and application evidence each show two exact owned removals; the
always cleanup and upload steps also succeeded. The retained
`.workflow/proofs/mr21-dast-2026-10-03/amd64-acceptance.json` and independent
review bind these observations. AC-12 is satisfied; no AMD64 detector-control
run is claimed. This completes the local contract, not the broader security
roadmap or whole-masterpiece approval. Lower-risk findings remain visible.

### Historical prerequisites and failure retention

This draft records the selected MR21 implementation contract under continued
roadmap work. The earlier prerequisites below do not themselves establish
product acceptance; the completed product observations are recorded above.
The retained ARM64 prerequisites observed the unchanged proxy readiness/drain,
Nuclei cold operation and positive native findings, and the corrected traditional
ZAP baseline with rule10062/risk3,61 enabled rules and5 scoped URLs. These
observations establish source/API/report prerequisites, not the product gate,
complete application scan, or AMD64 workflow result.

Preserve the first cold Nuclei harness failure: its scanner exited0 but an invalid
23-engine-unit/21-HTTP equality assertion failed. Retained evidence and the later
positive witness establish framing/detections/ignore-after hash; no cause is
assigned to two unobserved expansions. Preserve both failed ZAP baseline
generations (missing `__file__`, then native nonempty ignore list) and their
focused corrections. The successful third baseline's supervisor/container
cleanup exits are observed; its upstream Java child exit status is unobserved.
No failed receipt is rewritten into success.

Never-started AMD64 source inspection found the four selected scripts and all82
plugin files identical to ARM64; that is source identity only. Actual Linux/amd64
execution was still required at that stage; the dispatch above later met that gate. The state proof directory
`.workflow/proofs/mr21-dast-2026-10-03/` retains the bounded prerequisite records;
product behavior SHALL depend on committed inputs and fresh run evidence.

Tests SHALL be committed before implementation. Initial candidates are
`tests/ci/dast-target.test.mjs`, `tests/ci/dast-hook.test.mjs`,
`tests/ci/dast-supervisor.test.mjs`, plus report/isolation and owned-lifecycle/CI
acceptance fixtures derived from this contract. Feature-absence RED is distinct
from interpreter/module/setup failure. Fake API, filesystem, Unix-socket and
Docker fixtures do not replace the real detector controls, unchanged-app scan,
scoped cleanup and successful default-branch AMD64 dispatch required by AC-9/12.
Source review, successful skips or unit GREEN cannot close those live duties.

## Annex A — report bundle, verdict and isolation contract

THE SYSTEM SHALL implement this fixed wire under REQ-3–9.

### A.1. Files and admission

`node scripts/assert-dast-reports.mjs <run-dir>` accepts exactly one directory argument, resolved against CWD but contained under the script-derived project's `.workflow/proofs/dast/`. Its basename equals `run_id`, matching `mr21-dast-[0-9a-f]{32}`. Neither the directory nor any ancestor/selected file may be a symlink. Read only the fixed files below; do not enumerate or execute other artifacts. Open regular, single-link files with no-follow/nonblocking descriptor checks; enforce the inclusive cap before allocation and during bounded read. Strict UTF-8 applies to textual inputs. Missing, redirected, directory/FIFO, oversized or changed-size inputs refuse. No file writes, subprocess, network, scanner or automatic report synthesis.

| Fixed filename | Inclusive cap | Purpose |
| --- | ---: | --- |
| `run.json` | 256 KiB | Host envelope below; written after scans/export and before gate |
| `prepared.json` | 256 KiB | Frozen preparation/source/tool identity record |
| `isolation.json` | 256 KiB | Same-run network observations below; health is in run.json |
| `nuclei.jsonl`, `zap.json` | 10 MiB each | Unmodified native finding reports |
| `nuclei.stdout.log`, `nuclei.stderr.log`, `nuclei-errors.log`, `zap.stdout.log`, `zap.stderr.log` | 2 MiB each | Native captured streams/error log |
| `zap-before-report.json`, `zap-completion.json` | 256 KiB each | Fixed hook receipts, preserving measured event/queue/report ordering |

All JSON roots are objects except individual native JSONL records. Extra native metadata is retained but never interpreted as commands or projected into diagnostics. Runner-owned records require the declared fields/types; no caller-defined filenames or executable fields. `summary.json` and raw provisioning/process logs are upload artifacts, not gate inputs. A zero-byte `nuclei.jsonl` is valid only with complete evidence; every other required JSON document must exist and parse. An empty diagnostic stream remains a real hashed file.

### A.2. Host envelope and fixed identity

`run.json` fields are exactly these semantic fields (additional diagnostic metadata may be retained but cannot substitute):

- `schema_version:1`, `run_id`, `kind:"application"|"positive_control"`, `platform:"linux/amd64"|"linux/arm64"`, `origin:"http://127.0.0.1:18080"`, `seed:"http://127.0.0.1:18080/docs"`.
- `started_at`, `finished_at`: valid UTC RFC3339 strings; finished is not before start. `prepared_sha256`: lowercase64hex equal to the exact `prepared.json` bytes.
- `artifacts`: one entry for every fixed input except `run.json`, keyed by its literal basename. Each entry has `{bytes:nonnegative safe integer,sha256:lowercase64hex}`. Compare actual bytes/length, including empty files. No path values and no self-hash cycle.
- `stages.nuclei` and `stages.zap`: each `{started_at,finished_at,exit_code:integer|null,signal:string|null,timed_out:boolean,output_overflow:boolean}`. Completion requires signal null, timeout/overflow false, nuclei exit0, ZAP exit0 or2. Both windows are inside the run; nuclei finishes before ZAP starts. A failed/missing stage cannot be inferred complete from report existence.
- `containers`: `{anchor_id:64lowerhex,zap_id:64lowerhex,namespace:string}`. Namespace is a same-live-run equality witness only; IDs must differ. Observed engine image IDs are separate from manifest/config digests.
- `nuclei_runtime`: `{metrics_host:"127.0.0.1",metrics_port:18091,ignore_after_sha256}` with the pinned ignore hash. Metrics is observed through proc; no HTTP GET to `/metrics`.

`prepared.json` is the one source-owned preparation record: `{schema_version:1,platform,source_manifest_sha256,images,nuclei,templates,zap_hook_sha256,zap_common_original_sha256,zap_common_sha256}`. `source_manifest_sha256` binds the runner's actual narrow source/dependency manifest retained as an auxiliary artifact; it is a lowercase64hex identity, not a claim of code execution or remote attestation. `images.node`/`images.zap` each hold `{ref,engine_id,config_sha256}`. `nuclei` holds `{version:"3.11.1",archive_sha256,binary_sha256}`. `templates` holds `{commit,laravel_env_sha256,git_config_sha256,ignore_sha256}`. Digest-only hashes are lowercase64hex; observed Docker `engine_id` is exactly `sha256:<64lowerhex>` and is not assumed equal to a manifest/config digest. Exact platform image refs/archive/template/common pins must equal the committed policy, never a value supplied by the bundle. `zap_hook_sha256` must equal the source-owned product hook hash. Runner verifies mounted/source bytes before launch; the gate checks fixed pins and cross-file consistency, not the Docker daemon's honesty.

### A.3. Health and isolation evidence

`run.json.health` is an array of exactly five application observations, in order `initial`, `nuclei_before`, `nuclei_after`, `zap_before`, `zap_after`. Every observation has `phase`, `started_at`/`finished_at` inside the run. `isolation.json` separately carries `schema_version:1`, matching `run_id`, `kind`, `prepared_sha256`, and `anchor_id`.

Each application phase records the same positive safe-integer `proxy_pid`, `proxy_alive:true`, `health_status:200`, `health:{status:"ok",phase:"1-measurement-proxy"}`, `message_status:200`, `answer:"MR21 synthetic provider response"`, `input_tokens:23`, `output_tokens:7`, and nonnegative safe-integer `provider_before`, `provider_after`, `provider_rejected`. Require initial provider_before=0, each next provider_before equal to the previous provider_after, each provider_after=provider_before+1, and provider_rejected=0 throughout; final provider_after is exactly5. Every phase also records `capture:{sessions:1,turns:provider_after,input_tokens:23*provider_after,output_tokens:7*provider_after}` from its actual dashboard check; these expressions denote required numeric equalities, not string values. Initial additionally records `routes:{docs:200,openapi:200,dashboard:200,dashboard_graph:200}`. These are observed projections, not booleans standing in for unperformed requests.

Require each scanner's before-phase finish ≤ stage start ≤ stage finish ≤ after-phase start, and initial finishes before nuclei_before starts. Health must come from the same tracked proxy throughout. Readiness POSTs/provider counters are not scanner GET coverage. For `positive_control`, `run.json.health` is empty and `run.json.control_health` is exactly `{before:{status:200,marker:"MR21 synthetic detector control"},after:{status:200,marker:"MR21 synthetic detector control"},paths:[...]}`. Paths are actual observed root-relative strings, each beginning one `/` (never `//`), at most1024 characters and at most4096 entries; reject control characters, backslashes, query or fragment syntax. Resolve against the fixed origin and require it unchanged; no pretend proxy/provider fields. This kind cannot PASS even if otherwise clean.

`isolation.json` contains the exact finite projection in section A.7. It binds current namespace observations and inspected Docker identities; the gate calls the same pure validator used by the runner rather than trusting a `passed:true` field. Application TCP sets include proxy18080/provider18081, with metrics18091 only during nuclei and ZAP18090 only during ZAP; positive-control omits provider18081. No additional wildcard/listener/UDP is accepted.

### A.4. Nuclei native wire and completion

Parse `nuclei.jsonl` as one JSON object per nonempty physical line; LF and CRLF are accepted and a final terminator is optional. Whitespace-only/interior empty records refuse; zero-byte file means zero findings. Each record requires:

- `template-id` exactly `laravel-env` or `git-config`; `type:"http"`; `host:"127.0.0.1"`, `port:"18080"`, `scheme:"http"`, `url` exactly origin, `ip:"127.0.0.1"`, `matcher-status:true`.
- `matched-at`: absolute same-origin HTTP URL without userinfo/fragment, allowing its actual path/query. `info` object with exactly the pinned ID severity: `laravel-env`→`high`, `git-config`→`medium`. Unknown or mismatched severities refuse instead of downgrading a finding. `timestamp`: valid UTC RFC3339 inside nuclei's observed stage window (compare at millisecond precision while retaining raw fractional bytes).
- Other observed metadata (`template-url/path`, authors, descriptions, references, curl-command, meta) remains inert. Never invoke it, fetch it, echo it or use it to expand scope.

From bounded stderr, select every line whose trimmed content begins `{`; each must parse as a statistics object. Require exactly two. Reject native `[ERR]`/`[FTL]` diagnostics and nonempty `nuclei-errors.log`. Preserve other banner/INFO lines without emitting raw text. Each snapshot has exactly the required native values: decimal strings `errors,hosts,matched,percent,requests,rps,templates,total`; `duration` in the observed `H:MM:SS` form; valid UTC RFC3339 `startedAt`. Numeric strings are canonical nonnegative integers within safe integer range. Require templates2, hosts1, requests=total>0, errors0, percent100. Require snapshots equal for templates/hosts/matched/requests/total/errors/percent/startedAt; duration/rps may differ. startedAt lies inside the nuclei stage. Require each final matched counter to equal the number of parsed JSONL records, including0 for a real zero-byte file. The pinned normal HTTP WriteResult path writes one event then increments matched; failed writes cannot authorize a smaller/missing report. Honeypot-suppressed results are neither written nor counted. This is the fixed selected output path, not an assertion about other Nuclei modes. No separate fabricated stats file.

Projection counts JSONL records by severity and labels requests/total `engine_units`/`engine_total`. It never labels those counts HTTP requests. Application `observed_http_requests:null`; a control may separately retain its actually observed path count. The measured controls have23 engine units but21 HTTP requests. No general equality or hardcoded23 completeness oracle is introduced.

### A.5. ZAP native wire and hook completion

`zap.json` requires `@version:"2.17.0"`, exactly one `site`, and that site's `@name`=origin, `@host:"127.0.0.1"`, `@port:"18080"`, `@ssl:"false"`. `alerts` is an array, possibly empty. Each alert has canonical positive decimal-string `pluginid`, string `riskcode` in0/1/2/3, positive decimal-string `count`, and nonempty `instances` array with length equal to count. Every instance has a scoped absolute HTTP `uri` with no userinfo/fragment. Count alert groups and instances separately by risk. Preserve other native fields; do not require guessed metadata or use the printable warning summary as the findings source.

The two hook receipts keep the observed fields: `schema_version:1,run_id,seed,hook_sha256,events`. Final additionally has `urls,rules,report_sha256,report_bytes`. Require exact matching run/seed/product hook hash. Before events are `started,spider_entered,spider_returned,before_report`; final adds only `before_shutdown`, preserving the entire earlier event prefix. Every event has valid UTC `utc` inside the ZAP stage and canonical nonnegative decimal-string `monotonic_ns`, strictly increasing via BigInt within the hook process; no comparison with the host's monotonic clock. Require started namespace/listeners to match the owned live observation, spider target origin+`/`, and both queue values exactly string`"0"`. The fixed product hook path is `/dast/zap-completion.py`; do not rely on `__file__` in the upstream custom loader. The hook reads the separately mounted fixed `/dast/run.json` identity asset below, validates schema/run/kind/prepared hash, and chooses the exact application or positive-control listener set from its kind. No environment identity or default kind is admitted.

Final URLs are a nonempty array, at most4096, all scoped and containing exact seed. Rules are a nonempty array, at most512, with string `id,name,enabled,alertThreshold,quality,status`; enabled is `"true"` or`"false"`; include10062 enabledtrue. Preserve the actual pinned passive inventory; do not manufacture61 as generic coverage. Final report size/SHA must match the actual `zap.json` and envelope. Require before_report.utc ≤ before_shutdown.utc; the report hash is read only after generation. Native top-level `@generated` is preserved but not trusted as the causal ordering witness.

The hook preserves native ignore list `['-1','50003','60000','60001']` and empty out-of-scope mapping by identity. No additional ignore/config suppression is permitted. Gate severity inspection uses every raw JSON alert, independently of baseline print filtering. ZAP exit2 plus a risk3 alert is a complete high finding, never PASS; risk0/1/2 remain visible.

### A.6. Exact gate verdict and final runner summary

For every invocation emit one compact JSON object plus LF to stdout (≤4096 bytes), empty stderr. Exit0 only for an application PASS; all refusals exit1. No raw path/input/report values, dynamic property names, URLs or terminal controls in diagnostics; fixed JSON keys and validated enum/number/run-ID projections only. Unhandled internal failures are converted to the fixed reason `internal`.

Output fields: `{schema_version:1,run_id:string|null,kind:"application"|"positive_control"|null,verdict:"PASS"|"INDETERMINATE",reason,scan_complete:boolean,nuclei,zap}`. Validated run IDs only may be projected. `nuclei` is `{complete:boolean,counts:{info,low,medium,high,critical}|null,engine_units:integer|null,engine_total:integer|null,observed_http_requests:integer|null}`. `zap` is `{complete:boolean,alerts:{"0","1","2","3"}|null,instances:{"0","1","2","3"}|null,url_count:integer|null}`. Counts are nonnegative safe integers; malformed/missing evidence uses null, never invented zero. `scan_complete` means both scanners' terminal, completion and native report checks passed; a later health/isolation/finding refusal retains true and real counts.

Closed reason priority: `usage`, `input`, `binding`, `terminal`, `completion`, `report`, `scope`, `isolation`, `health`, `control_missing_detection`, `high_finding`, `control_only`, `ok`; `internal` is unexpected checker failure. Category precedence supplies one bounded reason, not a diagnostic framework. Complete nuclei high/critical or ZAP risk3 yields high_finding. A positive control also requires actual laravel-env/high and git-config/medium records plus10062/risk3 for its acceptance driver; absent expected detections is control_missing_detection, never PASS. `control_only` prevents zero findings under a control kind from being an application PASS. The acceptance driver separately asserts high_finding and the expected detections.

The read-only gate runs after required evidence export. Host runner then executes cleanup and writes final `summary.json` as `{...gate,cleanup:{complete:boolean,resources:[{id,removed,exit_code,signal}]},verdict,reason}`. Failed cleanup forces final INDETERMINATE/cleanup and nonzero runner status while preserving gate counts, scan_complete and earlier reason in `scan_reason`; successful cleanup cannot erase an earlier refusal. If launch fails before a valid bundle exists, runner writes a fixed failure summary with null counts plus available artifacts. Upload runs after cleanup under always semantics; no gate write or recursive summary input.

### A.7. Finite isolation wire and one shared validator

Source-owned `scripts/dast/isolation.mjs` exports `assertIsolation(record, context)`, a pure validation function used by the host runner and report gate. The host also uses `assertSnapshot(observation,{kind,namespace,container_id,phase})` and `assertDockerProjection(docker,{kind,prepared,anchor_id,zap_id})` to refuse invalid actual boundaries before scanning. These two narrow functions validate only their supplied real observation/projection, without inventing future events or accepting a partial final bundle. Full `assertIsolation` calls the same functions and still requires all five observations and complete temporal bindings; the report gate never uses a partial mode. `context` is their fixed parsed `{run_id,kind,prepared,prepared_sha256,anchor_id,zap_id,started_at,finished_at,stages}` data, not executable injection or runtime policy. Return `{namespace,phases}` on success; throw a fixed isolation-category error on refusal. No IO/subprocess/network inside this function. `scripts/dast/inspect-network.py` only collects the bounded native observations needed below; it does not supply an authoritative success boolean. Existing source policy is translated once into this pure validator, including parsing the retained raw routes/FIB/socket tables. Gate tests copy exactly `scripts/assert-dast-reports.mjs`, `scripts/dast/report-inputs.mjs`, `scripts/dast/isolation.mjs`, `scripts/dast/policy.json`, and `scripts/dast/zap-completion.py` before RED. The bounded reader/native parsers live in report-inputs and may be shared with the supervisor without any CLI command API.

Top-level record: `{schema_version:1,run_id,kind,prepared_sha256,anchor_id,namespace,docker:{anchor,zap},observations:[...]}`. ID/hash/kind values equal context; `namespace` matches `net:[positive decimal]` and every observation. Use equality only while the two named containers are alive. Never infer global uniqueness or reuse a previous run's observation.

Each Docker projection contains exactly the required fields `{id,image,config:{user},host:{network_mode,readonly_rootfs,privileged,cap_drop,cap_add,devices,device_requests,device_cgroup_rules,volumes_from,security_opt,port_bindings,publish_all_ports,extra_hosts,pid_mode,ipc_mode,tmpfs},mounts}`. `id` is the recorded distinct64hex ID; `image` is the prepared observed `sha256:<64hex>` engine ID. `config.user` is `1000:1000`; anchor network_mode is `none`, ZAP is `container:<anchor_id>`. Require privileged false, cap_drop exactly `["ALL"]`; cap_add, devices, device_requests, device_cgroup_rules and volumes_from each null or empty array; security_opt exactly `["no-new-privileges"]`, no port bindings (`null` or empty object), publish_all_ports false, extra_hosts null/empty array, pid_mode empty and ipc_mode `private`. Anchor readonly_rootfs true; disposable ZAP readonly_rootfs false. No Docker API Descriptor field is required: preparation validates exact RepoDigests/platform/Config/RootFS and Descriptor.digest only when present. Image ID is never substituted for manifest/config digest.

`tmpfs` is a map with exact allowed destinations: anchor `/tmp` and `/app/runtime/data`, ZAP `/tmp`; every value has rw,nosuid,nodev, finite size and mode1777. No exec-authority/capability is added. The preparation/runner uses one fixed tmpfs option string per target and the gate compares that source-owned string, not loose substring matching. Fixed values: `/tmp`=`rw,nosuid,nodev,size=128m,mode=1777`; anchor `/app/runtime/data`=`rw,nosuid,nodev,size=32m,mode=1777`.

Each bind mount projects `{type:"bind",asset,destination,read_only:boolean}` only after the runner compares Docker's actual Source with its exact prepared owned source path. `asset` is the closed source-owned identity in the mount roster below; arbitrary source paths are not inputs to the runner. The gate validates the exact asset/destination/read-only set, including no duplicate destination or extra mount. Runner retains the full original inspect JSON separately for audit. This projection is a consistency check under the trusted runner, not hostile-host attestation. Asset hashes are included in the preparation/source manifest; report output is the only writable bind asset. Engine-projected tmpfs mounts may be omitted from `mounts` because the exact HostConfig tmpfs map is checked separately.

| Container | Asset | Exact destination | Read only |
| --- | --- | --- | --- |
| anchor | app_runtime | `/app/runtime` | true |
| anchor | app_observability | `/app/observability` | true |
| anchor | dast_scripts | `/dast` | true |
| anchor | run_config | `/dast/run.json` | true |
| anchor | nuclei_binary | `/scanner/nuclei` | true |
| anchor | laravel_env | `/scanner/laravel-env.yaml` | true |
| anchor | git_config | `/scanner/git-config.yaml` | true |
| anchor | nuclei_ignore | `/scanner/default-ignore.yaml` | true |
| anchor | reports | `/out` | false |
| zap | dast_scripts | `/dast` | true |
| zap | run_config | `/dast/run.json` | true |
| zap | zap_common | `/zap/zap_common.py` | true |
| zap | reports | `/zap/wrk` | false |

`app_runtime` and `app_observability` are the two already proven narrow prepared trees (runtime source/dependencies/config and root redaction import), never the checkout or the preparation parent containing cache/config/home siblings. `dast_scripts` is the prepared fixed roster `proxy.mjs,nuclei.mjs,report-inputs.mjs,inspect-network.py,zap-completion.py,policy.json`, plus the regular zero-byte `run.json` mountpoint created before sealing and included with its constant empty-byte hash. The separate dynamic run_config bind overlays that placeholder; Docker must not create a missing target in the frozen readonly directory. No Docker authority or extra scripts are mounted. Positive-control replaces only the two anchor app assets with the fixed `positive_control` asset at `/control.mjs`, removes `/app/runtime/data` tmpfs, and keeps the same fixed scanner/helpers/output mounts. Its finite internal acceptance driver cannot be selected through the production CLI. Both namespaces remain independently fresh. `run_config` is a separate generated readonly file with exactly `{schema_version:1,run_id,kind,prepared_sha256}` matching context; it is not part of the fixed source-hash tree and is not the writable completed host `run.json` envelope. The runner validates its bytes/schema before mounting it; the mount record identifies that dedicated owned asset.

Observations are exactly ordered `nuclei_before,nuclei_live,zap_before,zap_live,zap_after`. Each is `{phase,started_at,finished_at,container_id,namespace,socket_tables,network?}`. UTC windows are inside the run; nuclei_before finishes before nuclei starts; nuclei_live lies inside nuclei; zap_before lies after nuclei and before ZAP; zap_live lies inside ZAP; zap_after begins after ZAP. Live nuclei container_id is anchor; other observations are from ZAP's fixed observer/hook and equal zap_id. Source/proc read errors refuse; an absent live observation is not synthesized from a final empty table.

Full `network` is required for nuclei_before, zap_before and zap_after; live stages carry their actually observed socket tables/namespace. This uses the full policy before each scan and after both, plus actual live listener observations; it does not fabricate ioctl data in the Node Nuclei process. Every full network object retains the exact inspected field names:

- `netns`: matching namespace string; `if_nameindex`:1..10 `[positive safe integer,string]` pairs, unique indices/names; `sysfs_entries`: unique string array at most128; `sysfs_noninterfaces`: exact set difference, only optional `bonding_masters`.
- `interfaces`: one record per if_nameindex pair: `{index,name,flags,admin_up,running,ifindex_sysfs,iflink_sysfs,flags_sysfs,type_sysfs,operstate_sysfs,address_sysfs,primary_ipv4,ipv6}`; index/flags are nonnegative safe integers (index positive), booleans exact, sysfs fields strings≤512bytes, primary_ipv4 string or null. Null requires `ipv4_absent_errno:99`; an actual address must not declare absence. `ipv6` is the corresponding parsed six-string-field rows from the raw IPv6 body. No omitted/duplicate interface is accepted.
- `ipv6_addresses_raw`, `routes4_raw`, `routes6_raw`: UTF8 strings≤65536bytes each; `fib_trie_raw`≤262144bytes. Reparse rather than trusting a derived list. IPv6 rows must have six fields, onlylo ::1/128; IPv4 route table only header, IPv6 only the committed observed lo forms; FIB has at least one parsed address and all are127/8.
- `security`: exact keys `Uid,CapInh,CapPrm,CapEff,CapBnd,CapAmb,NoNewPrivs`, all strings. Uid parses exactly four1000 values, every capability string parses hex0, NoNewPrivs exactly`"1"`. Interface tuple/flags/link/operstate/address/absence predicates must all match the committed REQ3 table, including loopback; a permitted name alone never admits a device. Cross-check flags booleans and sysfs/ioctl values.

Every `socket_tables` contains exactly UTF8 strings `tcp,tcp6,udp,udp6`, each≤262144bytes, with valid native headers/row framing. UDP tables contain only headers. Parse LISTEN(0A) rows from TCP tables, converting Linux little-endian words; normalize IPv4-mapped IPv6 to127.0.0.1. Require exact listener multiset, not only a subset: base `{127.0.0.1:18080,127.0.0.1:18081}` for application, only18080 for control; add18091 for nuclei_live and18090 for zap_live. No duplicate/fallback/wildcard listener is accepted. Non-LISTEN TCP rows remain retained but cannot authorize extra listeners. Require the hook's started socket tables/namespace to match the recorded zap_live observation exactly; nuclei_live comes from the actual proc snapshot already captured by its runner.

All prepared records, raw/projection fields and source/time hashes express observed consistency under the trusted owned runner. They do not prevent a privileged author from fabricating a bundle. Fresh actual scanner/application/CI acceptance remains required separately from parser fixtures.

## Annex B — private supervisor protocol

THE SYSTEM SHALL implement this fixed internal protocol under REQ-4/5/9. It is
not a public remote-command service or configurable production mode.

### B.1. One supervisor, one private socket

`scripts/dast/proxy.mjs` runs as UID1000 in the owned Node anchor. It owns the
local provider, actual proxy child and Nuclei child handles for their entire
lifetime. Its only control listener is `/tmp/dast-control/control.sock`, inside
a newly created 0700 directory, socket mode 0600. No additional TCP listener,
proxy route, loader injection, provider control endpoint or host socket mount.
The ZAP container shares the network namespace, not this private filesystem.

The internal CLI has exactly two forms:

```
node /dast/proxy.mjs serve
node /dast/proxy.mjs phase initial
```

The second form accepts only one of the phase literals below. Unknown mode,
extra/missing arguments or an unsupported phase refuse. The external production
`scripts/run-dast.mjs` still accepts no arguments and no mode/command/target
override. Every Docker-exec argv is constructed from fixed source literals.
Both internal forms read run identity from the same separate readonly
`run_config` mount at `/dast/run.json`, created by the host runner with exact
`{schema_version:1,run_id,kind,prepared_sha256}` fields. Do not accept an arbitrary
run-file or socket path.
`run_id` must match the adopted `mr21-dast-[0-9a-f]{32}` grammar; the readonly input is the runner-created identity asset, not the final report envelope.

The socket is a coordination channel inside a trusted owned workload, not an
authentication boundary against the host or another process with the same UID.
Do not describe it as a signed or privileged-host-resistant receipt service.

### B.2. Small framing and closed messages

One connection carries one UTF-8 JSON object plus one LF and then client write
EOF. Request cap1024 bytes, fatal UTF-8,2s framing deadline. Refuse empty input,
trailing second object/line, unknown keys, bad types or a mismatching run ID
before dispatching an operation. A framing deadline returns `deadline` with
phase null and no action; it does not poison a later well-formed request.
No raw request bytes enter diagnostics.

```json
{"schema_version":1,"run_id":"<fixed envelope ID>","phase":"nuclei_before"}
```

The Node server must use `allowHalfOpen:true`: the client ends its write side
after the complete request but still waits for the async response. Dispatch
only after EOF and successful whole-frame validation. This avoids accepting a
valid prefix before seeing a second message and avoids closing the response
side while an actual scan is running. Do not add a generic stream/RPC framework.

The client reads one response object plus LF followed by server EOF, cap64KiB,
with a phase-specific deadline. Its stdout is that one safe JSON reply; its
stderr is empty on an acknowledged operation. Protocol/transport failure emits
only `dast-control: unavailable\n` on stderr, no stdout, and exits1. It may retry
connection establishment for at most5s before sending anything; it never
resends a dispatched phase after a lost response. No alternate socket or TCP
fallback. Once connected, the response deadline includes the operation.

Successful reply (exact common keys):

```json
{"schema_version":1,"run_id":"<fixed envelope ID>","phase":"nuclei_before","sequence":2,"ok":true,"result":{}}
```

Acknowledged refusal (same common identity, no arbitrary error message):

```json
{"schema_version":1,"run_id":"<fixed envelope ID>","phase":"nuclei_before","sequence":1,"ok":false,"reason":"phase_order"}
```

The server always uses its own run ID; `phase` is the validated known phase or
null, never echoed unknown text. Sequence is a server-owned nonnegative integer:
increment after one operation succeeds, never from caller input. Client requires
matching run/phase, schema and the closed success/refusal shape before returning;
exit0 means an acknowledged successful operation, not a DAST PASS. `ok:false`
is emitted as the safe JSON reply but returns1.

Closed refusal codes: `protocol`, `phase_order`, `busy`, `startup`, `target_dead`,
`provider`, `health`, `nuclei`, `deadline`, `output_limit`, `shutdown`, `internal`.
Persist only a fixed code/known phase for unexpected exceptions, not the native
message or stack. Full bounded synthetic child logs remain separate artifacts.

### B.3. Finite ordered operations

| Phase | Required previous successful phase | Work | Maximum operation / client wait |
| --- | --- | --- | --- |
| `initial` | none | Start strict provider and real entry child once; establish health, one real message, exact answer/usage/counter/capture and all original HTML/OpenAPI/dashboard assertions | 30s /35s |
| `nuclei_before` | initial | Live tracked child + real health/message/counter-delta check | 20s /25s |
| `nuclei` | nuclei_before | Exact pinned binary/two templates/ignore/config/flags; proc-only18091 observation bound to child; finite terminal/output/report completeness | 45s plus bounded child drain /55s |
| `nuclei_after` | nuclei | Real health/message/counter-delta check | 20s /25s |
| `zap_before` | nuclei_after | Real health/message/counter-delta check | 20s /25s |
| `zap_after` | zap_before | Real health/message/counter-delta check; host separately proves actual ZAP terminal/completion sequence | 20s /25s |
| `drain` | any | Cancel/drain active Nuclei, drain proxy, close provider/control listener, persist terminal evidence | 20s /25s |

Use absolute phase deadlines, not a fresh full timeout for each request. Every
HTTP request remains capped5s and bounded256KiB, with no redirects. The local
provider retains the exact existing method/path/auth/model/messages validation,
fixed synthetic answer, input23/output7 usage and actual monotonic counter.
For each of exactly five health phases require provider delta1, zero rejected
requests, the real message result and capture. Initial starts at counter0;
each next before-counter equals the previous after-counter, ending at exactly5.
Each capture has sessions1, turns equal to observed successful roundtrips, and
input/output totals23/7 times that number. Preserve the zero-dropped-turn check. Initial-only routes remain exactly the passed
proxy prerequisite's checks. Readiness requests are not scanner coverage.

Only one substantive phase may run at once. Duplicate/out-of-order/busy requests
refuse without advancing phase or repeating a request/scan. A malformed command
does not execute an operation. An operation failure is sticky: after recording
it, only drain is allowed. Unexpected proxy/provider death or output overflow is
also sticky, regardless of whether the next health request has arrived.

Drain has priority over a running phase: abort that operation's bounded waits,
stop its scanner, then drain the proxy. It is never rejected as busy. The host
does not need a long operation to succeed before it can clean up. There is no
resume/replay mechanism, background job registry, arbitrary env update, process
ID from the caller or second Nuclei launch. Normal drain is performed once; a
lost reply is a failed transport with retained evidence, not an automatic retry
of earlier phases. The host's finally path can still inspect/remove its exact
container if the supervisor is unreachable.

### B.4. Results and persistent evidence

Keep result payloads small, closed and source-owned. Reuse Annex A's observation types; do not independently name native bundle paths here.

- Health result is exactly the report wire's health observation, without a
  second boolean-only vocabulary: `phase`, `started_at`, `finished_at`, the same
  positive `proxy_pid`, `proxy_alive:true`, `health_status:200`,
  `health:{status:"ok",phase:"1-measurement-proxy"}`, `message_status:200`,
  `answer:"MR21 synthetic provider response"`, `input_tokens:23`,
  `output_tokens:7`, `provider_before`, `provider_after`, `provider_rejected:0`,
  and `capture:{sessions:1,turns,input_tokens,output_tokens}` measured after the
  roundtrip. Initial alone adds
  `routes:{docs:200,openapi:200,dashboard:200,dashboard_graph:200}`. Counters and
  capture totals use the exact chain above. No response body other than the
  fixed answer, arbitrary headers or operator environment values are returned.
- Nuclei result: `kind:"nuclei"`, actual tracked terminal code/signal/deadline/
  overflow state, owned metrics address/port/PID witness, complete native engine
  summary projection and exact artifact hash references from the report wire.
  Reuse the same pure Nuclei completeness validator as the final report gate;
  do not duplicate parsing or infer validity from exit0 alone. A complete high
  finding is still a successful scanner operation; only the final finding policy
  labels it INDETERMINATE. It can remain useful evidence while ZAP completes.
- Drain result: `kind:"drain"`, both tracked child terminal records, provider
  closed flag and any shutdown deadline. Preserve the first failure separately;
  a successful cleanup never overwrites it with a successful run verdict.

The supervisor persists each completed observation/refusal to one bounded
auxiliary `supervisor.events.jsonl` before acknowledging it. The host records
the exact successful replies in the sealed health/lifecycle bundle and binds
its own ZAP events between before/after-ZAP. The supervisor does not attest an
external ZAP run merely because the host requested `zap_after`. The host invokes
`zap_after` only after the independently tracked ZAP operation is terminal. On lost response,
export the event file and fail; do not replay work to manufacture an ACK.

Nuclei's effective metrics listener can be observed while the real binary is
running without stalling/modifying the actual app. Its pinned clistats Start
waits250ms before request execution; use a short bounded proc observation loop
while watching the same child handle. Require actual inode ownership and exact
18091, never query `/metrics` or accept a fallback port. If the child completes
before observation, refuse missing evidence instead of inventing a listener.

Engine accounted units and actual HTTP requests remain different observations.
The positive prerequisite measured23 accounted/21 HTTP and two native findings;
the unchanged app has no per-GET access logger. Do not transplant the fixture
request counter, instrument the app or claim that23 requests reached it.

### B.5. Finite internal test seam (not a new CLI)

Keep two exports in `proxy.mjs`, without a new transport framework/module:

- `createPhaseController(runId, {perform, drain})` returns an object with async
  `handle(bytes)`. It validates the complete raw request frame, admits its phase,
  invokes `perform(phase,{signal})` or `drain()`, and returns the closed reply.
  Actions return the small result object; production actions are fixed source
  functions. Unexpected action exceptions map to `internal`, never their text.
  A result exceeding the64KiB encoded reply cap maps to sticky `output_limit`.
- `serveControl(socketPath, controller)` asynchronously returns its owned
  `net.Server` after binding a mode0600 Unix socket. It gathers the one bounded
  frame to EOF, then passes it to `handle` and sends one bounded reply+EOF.
  The production caller supplies only the fixed socket path; the unit fixture
  supplies its own project-local socket. Importing the module starts no process,
  listener or file operation. Returned server ownership enables exact teardown.

A drain arriving during a phase aborts its signal and settles that phase's
refusal (`shutdown`) before executing the drain action. Its unsuccessful phase
never increments sequence; drain increments once after success. Terminal drained
state refuses later commands as `phase_order`, including repeated drain. No
reconnect/resume turns a completed action into a second action. The host still
owns exact-container cleanup if an action will not settle within its deadline.

Tests import these fixed internals only after an explicit feature-exists guard.
They use synthetic in-memory actions and owned real Unix sockets; no Docker,
HTTP, app/provider, binary scanner, environment-file or process startup. Module
loader failures are prerequisite errors, not accepted policy refusals.
