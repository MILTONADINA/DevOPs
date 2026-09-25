# Provenance fixture: authoring record

Date: 2026-09-25. Brief: `specs/pruner/provenance-fixture-brief.md`. Requirement: REQ-15 of
`specs/pruner/provenance-gated-selection.md`.

These files were authored by an independent fixture author: a Claude Code agent working in a
separate detached worktree at `main` (3c32bba). They were committed before any candidate code
existed. The expectations are the author's reading of the brief. They were not produced by
running any code.

| File | SHA-256 |
|---|---|
| `pges-fixture.dev.jsonl` (39 cases) | `4719bde3c65ce0553ec59bb6bbb1bb2dfbf695077bc89961043e24a9308a72f7` |
| `pges-fixture.sealed.jsonl` (43 cases) | `1c233774958ffe0ca14793a8c9e8ed16970fb8061278641cb5f49f99533f3419` |

The `.sha256` beside each file holds `<lowercase hex>  <file name>` followed by a newline. This
is the format `shasum -a 256 -c` reads; run that command from this directory, because the
entries hold bare file names. The hash covers the file's exact bytes: ASCII only,
one compact JSON object per line, and `\n` line endings, including a final newline.

## Salt and split rule

Salt: `pges-indep-2026-09-25-vk3`

For every case, let `h = lowercase hex SHA-256 of the UTF-8 bytes of (salt + id)`, with no
separator between the two. Example: `sha256("pges-indep-2026-09-25-vk3" + "pg-dormant_sole-1")`.

1. Group the cases by `family`. Within a family, sort ascending by `h` and number the cases
   0, 1, 2, and so on, in that order.
2. Take the positions in pairs: (0, 1), (2, 3), and so on. In each pair, the earlier position
   goes to **dev** and the later one to **sealed**.
3. If a family has an odd count, one case is left over at the last position. It goes to
   **dev** when the first hex digit of its `h` is `0` through `7`, and to **sealed** when it
   is `8` through `f`.

The rule depends only on the salt and the ids. I chose the salt before generating anything
and never changed it.

The brief says only "halves by SHA-256(salt + id)", so I stratified by family. With a plain
parity split, 12 of the 29 families have two or three cases and would quite likely land
entirely in one half, leaving whole families out of the sealed gate. Re-rolling the salt
until that stopped happening would have been choosing the outcome.

## Family counts

82 cases in total: 39 dev and 43 sealed. Every family meets the brief's minimum, and every
family appears in both halves. `foreign_rows` has 3 cases (the minimum is 2): one each for
another conversation, another project and another organization.

| Family | Total | Dev | Sealed | Dev case numbers | Sealed case numbers |
|---|---|---|---|---|---|
| `dormant_sole` | 4 | 2 | 2 | 2, 3 | 1, 4 |
| `contested_unattested` | 4 | 2 | 2 | 1, 2 | 3, 4 |
| `contested_attested` | 4 | 2 | 2 | 1, 4 | 2, 3 |
| `multi_distinct_keys` | 4 | 2 | 2 | 1, 4 | 2, 3 |
| `decision_domain` | 4 | 2 | 2 | 2, 3 | 1, 4 |
| `todo_only` | 2 | 1 | 1 | 2 | 1 |
| `reviewed_obsolete` | 4 | 2 | 2 | 2, 3 | 1, 4 |
| `conflict_only` | 3 | 1 | 2 | 3 | 1, 2 |
| `successor_absent` | 3 | 1 | 2 | 1 | 2, 3 |
| `successor_chain` | 2 | 1 | 1 | 1 | 2 |
| `mixed_exchange` | 3 | 1 | 2 | 3 | 1, 2 |
| `suppressed_no_conflict` | 2 | 1 | 1 | 2 | 1 |
| `suppressed_successor` | 2 | 1 | 1 | 2 | 1 |
| `created_at_inversion` | 3 | 2 | 1 | 1, 2 | 3 |
| `partner_completion` | 3 | 1 | 2 | 3 | 1, 2 |
| `split_key_leak` | 3 | 2 | 1 | 1, 3 | 2 |
| `unreviewed_same_key` | 3 | 1 | 2 | 1 | 2, 3 |
| `older_authoritative_newer_draft` | 3 | 2 | 1 | 2, 3 | 1 |
| `noise_only_leak` | 2 | 1 | 1 | 1 | 2 |
| `low_similarity_decision` | 2 | 1 | 1 | 2 | 1 |
| `failed_write` | 3 | 1 | 2 | 2 | 1, 3 |
| `lookup_error` | 2 | 1 | 1 | 1 | 2 |
| `malformed_rows` | 2 | 1 | 1 | 1 | 2 |
| `foreign_rows` | 3 | 1 | 2 | 2 | 1, 3 |
| `duplicate_fact_id` | 2 | 1 | 1 | 1 | 2 |
| `no_exchange_ids` | 3 | 2 | 1 | 1, 2 | 3 |
| `unbound_mixed` | 2 | 1 | 1 | 1 | 2 |
| `foreign_scope` | 3 | 1 | 2 | 2 | 1, 3 |
| `equal_similarity` | 2 | 1 | 1 | 1 | 2 |

Every case is tagged `production_reachable` except `pg-successor_absent-3`, which is tagged
`long_window_not_production_reachable`. Its successor exchange has turn ages of 9400 s.
Every other turn age in the fixture is at most 6900 s, inside `windowMs` = 7,200,000 ms.
Three cases are tagged `db_rejects`: `pg-suppressed_successor-1`, `pg-suppressed_successor-2`
and `pg-created_at_inversion-3`. The two `suppressed_successor` cases are also tagged
`compose_only`.

## Independence

The author read only these files:

- `specs/pruner/provenance-fixture-brief.md`, in full;
- `specs/pruner/provenance-gated-selection.md`, lines 61-273 only (REQ-1 to REQ-18). To find
  those lines, the author ran `grep -n '^#'` on the file, which showed the names of the other
  headings: Definitions, Gate order, Files, Out of scope, Acceptance criteria, Delivery, and
  Decisions recorded 2026-09-25. Their contents were not read;
- `stratum/src/memory/warm/schemas.ts` and `stratum/src/types/facts.ts`, for fact field names
  and enums.

Besides reading those files, the author ran `git status` and `git log`, ran `wc -l` on the
files above, and ran `ls` on this (then missing) directory.

The author did not open, list or grep any of the following:

- `stratum/evals/datasets/golden/`, any Tier-B dataset, `locomo/` or `longmemeval/`;
- anything under `stratum/src/pruner/`;
- any `.workflow/` path;
- any scratchpad or `/private/tmp` directory;
- any other checkout of this repository.

The author has not seen the implementation, the Tier-C cases or their text. All prose is
original writing about invented software projects: Brambleton, Atlas, Quillfeather, Cinderpath,
Vaultkeeper, Oxbow, Mossgrove, Pinecomb and similar. None of it is copied from a benchmark. No
5-gram check against Tier-C or Tier-B could be run, because the author may not read those
files. Proper names are therefore spread through the text to keep shared 5-grams unlikely.

Each expectation and `predicted` block was written by hand from that case's declarations. No
selector, encoder or repository code was run, and none existed.

A throwaway Python script, never committed and deleted once authoring finished, did three
things:

- turned the hand-written cases into JSON;
- assigned the deterministic UUIDs;
- checked the declarations: `matchesQuery` against the brief's tokenizer rule, same-key pairs
  against the pairs the author intended, and filler text overlap.

A second throwaway check, run from stdin, re-read the written files and verified the following:

- every line parses as JSON, and ids, exchange IDs and fact IDs are unique;
- the family minimums hold, and the split matches the rule above;
- the `.sha256` files match the bytes;
- the enums, required fields, UUID formats and age limits are valid;
- `auditStatus` is null on every operational reference;
- link validity: reviewer at least 3 characters, evidence at least 20 characters, and an
  older successor only in a case tagged `db_rejects`;
- every listed exchange has a derivation, and no two lists contradict each other;
- every case has a `predicted` block;
- each anchor sits in the right exchange.

## Conventions a harness must know

- **IDs.** Every UUID is derived from `sha256("pges-fixture-uuid|" + label)` with the version 4
  and variant bits set. Ids take the form `pg-<family>-<n>`.
- **`nowSeconds`** is `1790240400` (2026-09-24T09:00:00Z) in every case. `ageSeconds` counts
  seconds before `nowSeconds`. Within a conversation every age is distinct, and in each
  exchange the user turn is older than the assistant turn.
- **`createdAtSeconds`** is set per fact. Ordinary facts are extracted 30 to 270 s after their
  exchange's assistant turn. Backfill and inversion cases set the extraction time explicitly
  and out of turn order. No fact is extracted before its own exchange ends.
- **`foreign`** holds exchange objects with this shape: `{ relation: "other_conversation" |
  "other_project" | "other_org", conversation: {orgId, keyId, sessionId, projectScopeId},
  exchangeId, write, turns, facts }`. Every foreign session differs from the case's session.
  A `reviewedLinks` entry may name a foreign fact.
- **Unbound turns inside expectations.** `"unbound:<i>"` in a list means `unboundTurns[i]`.
  This is used only in `unbound_mixed`.
- **`derivation` keys** are exchange IDs, `"unbound:<i>"`, or `"_case"`. `"_case"` carries the
  case-level reason for fallback cases, for `equal_similarity`, and for the "may" exchange in
  `pg-low_similarity_decision-2`. When a derivation cites a fact by its authoring label, a
  trailing `[fact labels: label=<factId>; ...]` maps the label to its fact ID.
- **`sameAsBase: false`** means the case makes no whole-decision assertion. It does not mean
  "must differ from the base".
- **List granularity.** `notAdded` and `notRemoved` are read per exchange. The base "selected
  an exchange" if it kept any of its turns. `notRemoved` therefore also encodes completion: if
  the base kept any turn, every turn of that exchange stays.
- **`db_rejects` cases** are expected to behave as if the database refused the link. No fact
  becomes reviewed-obsolete through that link, and the harness's injected layer must not honor
  it either.
- **Fault cases.** `malformed_rows` and `duplicate_fact_id` keep valid data, and the harness
  injects the fault through `lookupFault`. For `duplicate_fact_id`, the repeated fact is named
  in `_case`. For `foreign_rows`, the injected lookup returns the facts in `foreign`.
- **`matchesQuery` declarations.** Every `true` rests on a plain alphanumeric kept token that
  appears as a whole word in a searchable field. Every `false` fact contains no kept query token
  anywhere in its searchable fields, even as a substring, and avoids words that share a stem
  with a kept token. Declarations are also made for foreign facts.

## Interpretation choices

1. **`sameAsBase` and completion.** The brief makes the contest and pinned cases `sameAsBase`.
   Completion could still make the candidate differ from the base if the base kept only part
   of an exchange. The author followed the brief and kept both turns of each contested exchange
   on topic. A difference caused only by completion in these cases is a fixture finding, not a
   candidate failure.
2. **Successor in another conversation** (`successor_absent` 1 and 2). By the brief's dead-fact
   rule (same org and project), the stale fact is dead, so its exchange is forbidden. REQ-4's
   "shall not ... exclude" is read as: a foreign fact is never itself a subject of local
   rescue, contest or exclusion.
3. **Successor outside the window** (`successor_absent` 3). The successor sits in the same
   conversation but outside the window: its turns are 9400 s old and it was extracted later
   by a backfill. That exchange is `notAdded`.
4. **`foreign_scope` 3** uses a reviewed link from a decision in another project. The case is
   not tagged `db_rejects`, because the author does not know whether the database stores
   cross-project links. The expectation (local exchange required) holds either way.
5. **Suppressed facts** are treated as neither live nor dead: they cannot rescue, contest or be
   excluded. Only `pg-suppressed_no_conflict-1` (`notAdded` on a matching suppressed fact) rests
   on "cannot rescue". In the `suppressed_successor` cases the stale fact is kept non-matching.
6. **FunctionChange keys** may be one composite key or two separate keys. Contested pairs share
   both `old_name` and `new_name`. Distinct pairs share neither.
7. **`split_key_leak`.** The stale exchange appears only in `pinnedLimitation` (`selected`), as
   the brief says, and not in `requiredExchangeIds`. The current exchange is required.
8. **`low_similarity_decision` 2.** The non-matching decision is left as "may", as the brief
   says, although `notAdded` would also follow from the rules.
9. **`equal_similarity`** makes no list assertion. Its only expectation, determinism, is stated
   in `_case`.
10. **Extra assertions beyond the brief.** Filler exchanges are marked `notAdded` and
    `notRemoved` wherever the rules imply it. `pg-decision_domain-2` adds an unreviewed,
    model-extracted `supersedes_id`, which must not kill a fact (REQ-5).
11. **"Core family"** is not defined in the brief. The at-least-half-production-reachable rule
    holds for every family.
