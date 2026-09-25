# Authoring brief: provenance fixture for provenance-gated exchange selection

You are writing an independent test fixture. You define what a correct selector
must do, using only the provenance each case declares. You do not know how the
selector is implemented, and you must not find out before your files are
committed.

## Independence rules (binding)

1. Do NOT open:
   - `stratum/evals/datasets/golden/` or any Tier-B dataset;
   - `stratum/evals/datasets/locomo/` or `longmemeval/`;
   - `stratum/src/pruner/provenance-select.ts`;
   - any `.workflow/proofs/*` file about Tier-C, LoCoMo or LongMemEval;
   - any scratchpad directory.

   You MAY read `stratum/src/memory/warm/schemas.ts` and
   `stratum/src/types/facts.ts` for fact field names, and the REQ sections of
   `specs/pruner/provenance-gated-selection.md`.
2. Write all new text about software-project work of your own invention. A
   checker rejects any 5-gram shared with the golden Tier-C/Tier-B files, and
   any text taken from a published benchmark.
3. Derive every expectation from the case's own declarations (exchanges,
   facts, reviews, audit statuses, write outcomes, scope). Never derive one by
   running a selector or an encoder.
4. Before any run, write a `predicted` block for each case. If it later turns
   out wrong, it is reported as a finding and nobody edits it.
5. Split the cases deterministically into halves by SHA-256(salt + id), with a
   salt you choose and record in `AUTHORING.md`. Write
   `pges-fixture.dev.jsonl` and `pges-fixture.sealed.jsonl`, plus a `.sha256`
   file for each, and commit all of them before any candidate code exists. The
   sealed half is opened once, at the final gate.

## What the selector does, stated as behavior

A base selector (treat it as a black box) keeps some turns of a conversation
for a query. An overlay may change that choice, using only these recorded
facts about earlier exchanges. An exchange is one user turn plus one assistant
turn, sharing a server-issued UUID.

- **Rescue (adds).** An exchange is added whole when three things hold:
  - it has a live, keyed typed fact that matches the query;
  - none of its facts is dead;
  - none of its keyed facts is contested.

  Rescue never adds the exchanges lying between two added ones.
- **Keys.** The identity keys are:
  - FunctionChange: `old_name` and `new_name`;
  - VariableChange: `var_name`;
  - PolicyUpdate: `policy_name`;
  - OperationalReference: `subject`;
  - TechDecision: `domain`, but two TechDecisions contest only when BOTH match
    the query.

  Todo has no key and never makes an exchange eligible. Keys compare exactly
  after trimming spaces and lowercasing. `db-url` and `db_url` are different
  keys.
- **Contest.** Two live keyed facts from different exchanges, in the same
  table and with the same key, contest each other.
  - A contest is never broken: both facts are contested, and the base
    decides, whichever one is newer.
  - Recency, extraction time, wording and git audit status (`CONFIRMED`)
    never break a contest.
- **Dead facts.** A fact is dead when either of these holds:
  - it is a TechDecision with a reviewed successor. A reviewed successor is
    a later-created, unsuppressed TechDecision in the same org and project,
    with a reviewer of at least 3 characters and evidence of at least 20
    characters;
  - its audit status is `CONFLICT`.
- **Exclusion (the only way to drop).** An exchange whose facts (at least one)
  are ALL dead is removed, even if the base kept it. An exchange stays in
  whatever state the base left it when it has any of these:
  - a live fact;
  - a manually suppressed fact without `CONFLICT`;
  - no facts at all.
- **Successor transfer.** When an excluded exchange was selected or has a dead
  fact that matches the query, its reviewed successor's exchange is added. The
  chain is followed to its end, within this conversation and window only. If
  there is no such exchange, nothing is added.
- **Completion.** If any turn of an exchange ends up selected, all of its turns
  are selected, unless the exchange was excluded.
- **Fallback.** The whole decision must equal the base when any of these holds:
  - any in-window exchange had a failed memory write;
  - the lookup errors;
  - the lookup returns malformed, duplicate or foreign rows;
  - no turn carries an exchange ID.

  Turns without an exchange ID are never rescued, excluded or completed.
- **Query match.** Each fact's match against the query is declared. Declare it
  so that it is true under this rule:
  - Take the query in lowercase, cut to 1,200 characters, and split it into
    tokens made of `a-z 0-9 _ . / : -`.
  - Keep tokens of 3 or more characters that are not stopwords, up to the
    first 16. The stopwords are: the, and, for, from, with, that, this,
    which, what, where, when, how, are, was, were, does, have, has, its, our,
    their, into, about, should.
  - The fact matches when one kept token appears as a whole word in one of the
    fact's searchable fields:
    - FunctionChange: `old_name`, `new_name`, `file_path`, `language`,
      `change_type`;
    - TechDecision: `decision_text`, `domain`, `rationale`;
    - PolicyUpdate: `policy_name`, `old_value`, `new_value`, `policy_type`;
    - Todo: `description`, `status`;
    - VariableChange: `var_name`, `old_value`, `new_value`, `context`;
    - OperationalReference: `subject`, `reference`.

  For a clean match, use a distinctive plain alphanumeric word, with no
  `_ . / : -`. For a non-match, make sure the fact shares no kept token with
  the query. A Compose check verifies each declaration against the real
  database.

## Record schema (one JSON object per line)

```
{
  "id": "pg-<family>-<n>",
  "family": "<family code below>",
  "tags": ["production_reachable" | "long_window_not_production_reachable" | "db_rejects" | "compose_only"],
  "conversation": { "orgId": uuid, "keyId": string, "sessionId": uuid, "projectScopeId": "org/slug" | null },
  "windowMs": 7200000,
  "nowSeconds": <fixed integer>,
  "query": string,
  "exchanges": [ {
    "exchangeId": uuid,
    "write": "ok" | "failed",
    "turns": [ { "role": "user" | "assistant", "text": string, "ageSeconds": number, "scopeId": string } ],
    "facts": [ {
      "factId": uuid,
      "table": "function_changes" | "tech_decisions" | "policy_updates" | "todos" | "variable_changes" | "operational_references",
      "fields": { ...typed fields per schemas.ts... },
      "isSuppressed": boolean,
      "createdAtSeconds": number,
      "auditStatus": "CONFIRMED" | "UNVERIFIED" | "CONFLICT" | null,
      "matchesQuery": boolean
    } ]
  } ],
  "unboundTurns": [ { "role", "text", "ageSeconds", "scopeId" } ],
  "reviewedLinks": [ { "newerFactId", "olderFactId", "reviewer", "evidence", "reviewedAtSeconds" } ],
  "foreign": [ ...facts or exchanges belonging to another org, conversation or project... ],
  "lookupFault": null | "reject" | "timeout" | "malformed" | "foreign_row" | "duplicate_fact_id",
  "expect": {
    "fallback": null | "NO_SNAPSHOT" | "NO_EXCHANGE_IDS" | "WRITE_FAILED" | "LOOKUP_ERROR" | "LOOKUP_INVALID",
    "sameAsBase": boolean,
    "requiredExchangeIds": [],
    "forbiddenExchangeIds": [],
    "notAddedExchangeIds": [],
    "notRemovedExchangeIds": [],
    "pinnedLimitation": [ { "exchangeIds": [], "behavior": "selected" | "sameAsBase", "reason": string } ],
    "derivation": { "<exchangeId>": "the provenance declaration behind this expectation" }
  },
  "predicted": { "base": "pass" | "fail" | "unknown", "candidate": "pass" | "fail" | "sameAsBase", "why": string },
  "anchors": { "evidence": [substrings of required exchanges], "forbidden": [substrings of forbidden exchanges] }
}
```

Field notes:
- `createdAtSeconds` is extraction time. Set it independently of turn age.
- `auditStatus` is always null for `operational_references`.
- The expectation lists mean:
  - `requiredExchangeIds`: every turn must be selected;
  - `forbiddenExchangeIds`: no turn may be selected;
  - `notAddedExchangeIds`: selected only if the base selected it;
  - `notRemovedExchangeIds`: if the base selected any of its turns, all of its
    turns stay.
- Every exchange ID in `expect` needs a `derivation` entry. An exchange ID left
  out of every list means "may": it depends on the base.
- `tags`: use `db_rejects` for a reviewed link the database must refuse, and
  `compose_only` for a case that runs only against local Compose.

## Families and minimum counts (at least 80 cases in total)

Unless a case is tagged `long_window_not_production_reachable`, keep all ages
within `windowMs` (2 h). At least half of the cases in every core family must
be production-reachable.

**Rescue (22)**
- `dormant_sole` (4): the earliest exchange holds the only live fact for its
  key, and that fact matches the query. Two or more later exchanges do not
  match. That exchange is required.
- `contested_unattested` (4): an older and a newer exchange share a key and
  both are live, with no audit status and no review. Neither is rescued (both
  are `notAdded`), and the case is `sameAsBase`.
- `contested_attested` (4): a VariableChange or FunctionChange pair. The older
  fact is `CONFIRMED`; the newer is `UNVERIFIED`. Audit status does not break a
  contest, so this must behave like `contested_unattested`: both are
  `notAdded`, and the case is `sameAsBase`. Add one variant where both are
  `CONFIRMED`.
- `multi_distinct_keys` (4): two matching exchanges with different keys, with
  1 to 3 non-matching exchanges between them. Both are required, and the
  middle exchanges are `notAdded`.
- `decision_domain` (4): two TechDecisions in the same domain.
  - (a) Both match the query: they contest, both are `notAdded`, and the case
    is `sameAsBase`.
  - (b) Only one matches: that one is required.
- `todo_only` (2): an exchange whose only fact is a matching Todo is
  `notAdded`.

**Exclusion and transfer (22)**
- `reviewed_obsolete` (4): the only fact of the stale exchange is a
  TechDecision reviewed-superseded by a later decision in the window. The
  stale fact matches the query. The stale exchange is forbidden and the
  successor is required. Include cases where the two are adjacent.
- `conflict_only` (3): all of the exchange's facts are `CONFLICT`. It is
  forbidden.
- `successor_absent` (3): the successor is in another conversation, or
  outside the window. The stale exchange is forbidden and nothing else is
  required.
- `successor_chain` (2): A is superseded by B, and B is superseded by C, all in
  the window. A and B are forbidden; C is required.
- `mixed_exchange` (3): a reviewed-obsolete decision plus a live unrelated
  fact. The exchange is `notAdded` and `notRemoved`.
- `suppressed_no_conflict` (2): a manually suppressed fact with no
  `CONFLICT`. The exchange is `notRemoved`.
- `suppressed_successor` (2, tags `db_rejects`, `compose_only`): the database
  must refuse the link.
- `created_at_inversion` (3): extraction times run in the opposite order to
  turn times. Exclusion follows the declared link. Include one `db_rejects`
  case where the link's successor was extracted earlier.

**Completion (3)**
- `partner_completion` (3): answer text sits in the assistant turn, and the
  user turn is only relevant to the query. Invariant: no exchange ends up
  partly selected.

**Pinned known limitations (13)**
- `split_key_leak` (3): an older stale fact and a newer current fact name the
  same thing with different keys (a punctuation or abbreviation variant). The
  stale fact matches the query and is rescued. Declare it as
  `pinnedLimitation` with behavior `selected`.
- `unreviewed_same_key` (3): stale and current share a key, with no review.
  The case is `sameAsBase` (a pinned limitation).
- `older_authoritative_newer_draft` (3): an older authoritative
  OperationalReference and a newer draft with the same subject. They contest,
  so the case is `sameAsBase` (a pinned limitation; the draft may leak).
- `noise_only_leak` (2): a fact-less noise exchange next to the answer. It is
  `notRemoved`.
- `low_similarity_decision` (2): a correct decision whose text is phrased
  unlike the query. Declare `matchesQuery` honestly; if it does not match, the
  exchange is "may".

**Fallback and negatives (16)**
- `failed_write` (3): the decision equals the base, with reason
  `WRITE_FAILED`.
- `lookup_error` (2): reason `LOOKUP_ERROR`.
- `malformed_rows` (2): reason `LOOKUP_INVALID`.
- `foreign_rows` (2): one row from another conversation and one from another
  project. Reason `LOOKUP_INVALID`.
- `duplicate_fact_id` (2): reason `LOOKUP_INVALID`.
- `no_exchange_ids` (3): reason `NO_EXCHANGE_IDS`, `sameAsBase`.
- `unbound_mixed` (2): unbound turns beside bound exchanges. The unbound turns
  are `notAdded` and `notRemoved`.

**Scope (3)**
- `foreign_scope` (3): a matching or same-key fact from another project or
  conversation must not rescue, contest or exclude.

**Clock (2)**
- `equal_similarity` (2): turns with identical text, a fixed `nowSeconds`, and
  small age differences. The expectation is only that repeated runs give an
  identical decision.

## Deliverables

- `stratum/evals/datasets/provenance/pges-fixture.dev.jsonl`
- `pges-fixture.sealed.jsonl`
- a `.sha256` file for each
- `AUTHORING.md`, stating the salt, the family counts, your ignorance of the
  implementation and of Tier-C, and the date

Commit them before any candidate code is written.
