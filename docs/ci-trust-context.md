# CI Trust Context

**Status:** Implemented reference

**Purpose:** Define the evidence gitworkshop can use when describing trust in
CI coordinators, compute providers, and their results

**Scope:** Trust semantics, canonical language, and resolution state only; page
layout, visual treatment, ranking, and filtering are deliberately out of scope

---

## Why This Exists

Nostr CI is permissionless. Any key can advertise CI capabilities, claim to
watch a repository, publish workflow results, or publish job results. A valid
signature proves which key made a claim; it does not prove that a repository
maintainer requested the work or that the result is correct.

At the same time, gitworkshop has more useful evidence than a binary
"maintainer requested" flag:

1. repository maintainers can explicitly request CI;
2. a repository announcement identifies the infrastructure its resolved
   maintainer graph uses, and coordinators can delegate jobs to separate
   provider keys; and
3. coordinators and providers may have started or completed CI work for
   repositories maintained by people the viewer follows.

This document calls the combined evidence a **CI trust context**. Trust context
describes why a result may deserve attention. It is not a guarantee of
correctness, safety, availability, or good behavior.

## Identities and Claims

The trust context keeps these identities distinct:

- A **repository maintainer** is a pubkey in the repository's resolved
  maintainer model.
- A **coordinator** schedules or accepts CI work and signs Workflow Progress
  and Workflow Result events.
- A **provider** executes an individual job and signs the Job Result.
- A **GRASP server** hosts Git repositories and exposes relay/server
  infrastructure under a DNS domain.
- A **viewer contact** is a pubkey in the current viewer's follow graph.

A coordinator and provider may use the same key, but they do not have to. A
coordinator may allocate jobs to multiple provider keys, including multiple
runners operated beneath the same GRASP domain or providers on unrelated
infrastructure.

Each signed event remains the claim of its signer:

- a Job Result is the provider's execution claim;
- a Workflow Result is the coordinator's acceptance and combined conclusion;
- a Service Request or Manual Trigger is a maintainer's request; and
- a repository announcement is its author's statement about repository
  identity, maintainers, and infrastructure.

Trust evidence may connect these identities, but it MUST NOT collapse them into
one identity or silently transfer every property of one signer to another.

## The Three Trust-Context Levels

The levels are ordered by how directly they connect a result to the repository
or the viewer. Multiple levels may apply at the same time. The strongest level
does not erase the supporting evidence from the others.

Implementations represent these as semantic classifications rather than a
numeric score:

```text
MaintainerDirected
OperationallyAssociated
SeenInYourNetwork
NoKnownContext
```

`NoKnownContext` is an absence-of-evidence state, not a fourth positive trust
level and not a statement that the signer is unsafe. Its canonical human label
is **No known context**.

### Level 1: Maintainer-Directed

**Meaning:** A repository maintainer explicitly requested the coordinator's
service or the particular run.

Qualifying evidence includes:

- a valid, active Service Request authored by a confirmed repository
  maintainer and addressed to the coordinator;
- a valid Manual Trigger authored by a confirmed repository maintainer for the
  workflow/run context; or
- immutable service-control history proving that a standing maintainer request
  was active when the coordinator accepted the run.

A per-run quote is evidence only after the quoted request event has been
retrieved and validated. The quote's event ID, kind, author, repository,
coordinator, and relevant run context MUST agree. A coordinator-authored `q`
tag containing a maintainer pubkey is not sufficient by itself.

Service controls are temporal. A later Service Stop prevents future runs from
claiming the active request, but it does not rewrite the trust context of a run
that was covered when it started. Conversely, a request published after a run
does not endorse the earlier run.

Recommended language:

- **Maintainer requested**
- **Requested by a repository maintainer**
- **Covered by a maintainer's service request when this run started**
- **Earlier maintainer direction**, when grouping historical coordinator
  relationships; the evidence should distinguish manual runs from a stopped
  standing request and identify the request signer when available

This is the only level that may claim the maintainer requested CI. The other
levels can coexist with the narrower statement **Not maintainer-requested**.

### Level 2: Operationally Associated

**Meaning:** There is signed or independently verified evidence connecting the
coordinator/provider to infrastructure used by the repository, or connecting a
provider to a coordinator that selected or accepted it.

Level 2 is an operational trust path. It suggests that an authoritative party
chose to use the infrastructure or signer. It does not prove that a maintainer
requested the particular CI run.

There are two primary Level 2 paths.

#### Repository Infrastructure Association

The resolved repository is the union of the infrastructure published by its
resolved maintainer graph. Its current `clone` tags therefore provide a signed,
repository-scoped indication of which GRASP servers the repository uses.

The association can be expressed as:

```text
resolved repository
  -> signed repository announcement
  -> GRASP clone URL domain
  -> verified NIP-05 identity
  -> coordinator or provider pubkey
```

The provenance of each clone URL SHOULD be retained so the evidence can name
the announcement and signer that contributed it. The effective union is valid
repository evidence even when multiple announcements contribute different
servers.

A coordinator or provider qualifies for repository infrastructure association
when either:

1. the signer publishes a NIP-05 identifier, it resolves back to that signer
   pubkey, and its domain has an exact or qualified relationship to a GRASP
   domain in the resolved repository's clone URLs; or
2. the root NIP-05 identifier (`_@grasp.example`) of a GRASP domain in the
   resolved repository's clone URLs resolves directly to the signer pubkey.

The second path does not require the signer to duplicate `_@grasp.example` in
its kind:0 profile. The repository already names the domain and the domain's
NIP-05 document independently names its root key.

For a root NIP-05 identity, a matching NIP-11 operator pubkey strengthens the
association by showing that the GRASP server also identifies the root signer
as its operator. A missing NIP-11 operator key does not invalidate a verified
NIP-05 mapping, but the evidence MUST be described more narrowly. A
conflicting NIP-11 operator key is counter-evidence to a root/operator claim
and MUST be disclosed rather than treated as a match.

A named provider identity under the same domain is not expected to match the
NIP-11 operator pubkey. The provider has its own signing key. Its verified
NIP-05 mapping shows that the GRASP domain issued the provider identity, while
a signed allocation or accepted result establishes how the provider relates
to a coordinator and job.

Recommended language:

- **Uses repository-listed infrastructure**
- **Associated with a GRASP server listed by this repository**
- **Root GRASP operator key matches this signer**, when verified
- **Provider identity issued by a repository-listed GRASP domain**
- **Identity is hosted by a repository-listed GRASP domain**, when NIP-05
  resolves but operator ownership is not established

#### Coordinator Delegation

A coordinator may use a different provider key to execute a job. A valid,
coordinator-signed allocation addressed to that provider is evidence that the
coordinator selected the provider for that job. A coordinator's Workflow
Result that quotes and accepts a provider-signed Job Result is also evidence of
an operational relationship, although an explicit directed allocation is the
clearer signal.

The association can be expressed as:

```text
maintainer or repository evidence
  -> coordinator
  -> signed job allocation or accepted job result
  -> provider
```

Delegated trust is scoped to the allocated or accepted job. It does not make
the provider a repository maintainer, prove that the maintainer selected the
provider directly, or create a permanent global endorsement of the provider.
Repeated delegation may be useful reputation evidence, but it does not become
Level 1 without a direct maintainer request path.

Recommended language:

- **Selected by the coordinator for this job**
- **Job allocated by this coordinator**
- **Provider result accepted by this coordinator**
- **Operationally associated with a maintainer-recognized coordinator**, when
  the coordinator has independent maintainer or infrastructure evidence

### Level 3: Seen in Your Network

**Meaning:** The current viewer can observe prior started or completed CI
activity connecting the coordinator/provider to a repository maintained by
someone they follow.

This is subjective, viewer-relative network evidence. A relationship on another
repository does not become maintainer direction for the repository currently
being viewed. It shows only that the identity has participated in CI activity
on repositories maintained by people the viewer follows.

There are two strengths of Level 3 evidence.

#### Contact-Requested Activity

A valid Service Request or Manual Trigger authored by a followed person, and
addressed to the coordinator while that person was authorized for the
referenced repository, is direct evidence that the contact chose the
coordinator. The resulting run MUST carry validated request provenance before
it can support this claim.

When that coordinator allocates a job to a separate provider, the
seen-in-your-network evidence may follow the signed allocation to that provider
for the allocated job. The language must still distinguish the contact's choice
of coordinator from the coordinator's choice of provider.

Recommended language:

- **A person you follow requested CI from this coordinator**
- **Seen in your network: requested by N people you follow**
- **Selected by a coordinator seen in your network**, for a separately
  allocated provider

#### Observed Started Activity

A valid Workflow Progress, Workflow Result, or Job Result with a reliable
`started_at` value can show that a coordinator or provider started work for a
repository whose resolved maintainer graph contains someone the viewer
follows. A terminal result also establishes that work took place when an older
publisher omitted `started_at`.

This evidence is weaker when no followed person authored the request. The
activity event is a claim by the coordinator or provider, and permissionless
publishers can produce unsolicited results for any repository. In that case,
the language may describe the observed activity but MUST NOT say that the
followed person chose, requested, approved, or trusted the signer.

Recommended language:

- **Has run CI for a repository maintained by someone you follow**
- **CI activity observed on repositories in your network**
- **Prior provider activity found for N people you follow**

Avoid language such as **verified by**, **approved by**, or **trusted by your
contacts** unless signed request provenance supports that stronger claim.

## Domain and Subdomain Evidence

GRASP operators may use the NIP-05 root identity for the high-level
coordinator/operator and issue named identities to separate job providers. The
root identity is written as `_@<grasp-domain>` and, following NIP-05 display
semantics, is represented to people as the bare domain without `_@`.

The identity hierarchy is:

```text
_@<grasp-domain>                         root coordinator/operator
<platform>@<grasp-domain>                provider
<platform>-<runner-id>@<grasp-domain>
                                         provider, when several runners exist
```

For example, a root coordinator and two provider keys might resolve as:

```text
_@grasp.example.com       -> grasp.example.com
act-1@grasp.example.com   -> act provider 1
act-2@grasp.example.com   -> act provider 2
```

The `_` local part has the root-display meaning defined by NIP-05. A provider's
`<platform>` and `<runner-id>` local-part components are descriptive metadata,
not proof of a platform, role, or relationship. Each verified NIP-05 mapping
establishes its distinct signer identity. Allocation and result events
establish the coordinator/provider roles actually used for a job.

Domain relationships have different strengths:

1. **Exact root domain** — the NIP-05 domain exactly matches the host of a
   repository-listed GRASP clone URL. A verified `_@<domain>` identity is
   direct root/operator association. A verified named identity such as
   `act-1@<domain>` is direct evidence that the domain issued that provider
   identity, but does not make the provider the root operator.
2. **Parent/child subdomain** — one verified domain is a proper DNS subdomain
   of the other, compared on DNS-label boundaries. This is related-domain
   evidence with lower confidence because subdomains can be delegated to
   different operators.
3. **Sibling subdomains** — two hosts merely share a parent domain. This is not
   sufficient by itself. It becomes useful only when independent evidence,
   such as matching NIP-11 operator keys or a canonical server identity,
   establishes the common operational boundary.

Implementations MUST NOT use string suffixes without DNS-label boundaries.
For example, `runner.grasp.example` is a subdomain of `grasp.example`, while
`grasp.example.evil.test` is not. Implementations also MUST NOT assume that a
shared public registrable suffix establishes a shared operator.

Recommended language for weaker domain evidence:

- **Associated with a subdomain of repository-listed infrastructure**
- **Related GRASP domain; operator relationship not independently verified**

Subdomain evidence can support Level 2, but it MUST remain distinguishable from
an exact domain and matching operator key.

## Evidence Scope and Propagation

Trust context follows explicit edges and remains scoped:

- Maintainer direction applies to the addressed coordinator and covered run.
- Repository infrastructure association applies independently to each signer
  whose NIP-05/domain relationship is verified.
- Coordinator evidence reaches a separate provider only through a signed
  allocation or accepted result, and only for the relevant job.
- Provider evidence does not flow backward to the coordinator.
- Seen-in-your-network evidence applies to the identity that signed or was
  selected for the observed activity and to the current viewer. It transfers
  from a coordinator to a provider only through a signed allocation or accepted
  provider result, with the weaker delegated wording.
- A live Advertisement, Request-Readiness entry, Repository Status, successful
  job, or valid signature is not trust context by itself.

Corroborating paths should be preserved. For example, a provider may both use a
NIP-05 identity on a repository-listed GRASP domain and have a signed allocation
from a maintainer-requested coordinator. Those are two independent Level 2
reasons, not one duplicated signal.

## Current and Historical Context

Trust context can change:

- maintainers can request or stop coordinator service;
- repository announcements can add or remove clone URLs;
- NIP-05 and NIP-11 mappings can change;
- coordinators can choose different providers; and
- viewers can follow or unfollow the maintainers whose prior activity supplies
  seen-in-your-network evidence.

Evidence MUST identify whether it describes the current relationship or the
relationship at the time of a run. Immutable signed service controls and
allocations can establish historical context. Current DNS, NIP-05, repository
announcements, and follow data MUST NOT be described as historical fact unless
a verifiable historical snapshot is available.

Recommended temporal language:

- **Currently listed by this repository**
- **Was requested when this run started**
- **Has started CI for repositories maintained by N people you follow**
- **Current identity mapping matches**

## Resolution and Coverage

Trust context MUST remain unresolved while any relevant initial query is still
loading. A client must not temporarily classify a signer as **No known
context** merely because repository relationships, profiles, NIP-05 mappings,
or viewer-relative network evidence have not settled yet.

The resolution state is independent from the classification:

```text
loading
settled + complete coverage
settled + partial coverage
```

A relay failure or bounded identity-resolution failure counts as settled so a
client cannot wait forever, but it produces partial coverage. The canonical
partial-coverage label is **Context incomplete**. Known positive evidence may
still be described, but missing evidence paths must not be presented as a
final negative conclusion.

## What Trust Context Does Not Prove

No level, alone or combined, proves that:

- a CI result is technically correct;
- the executed source matches an intended commit without independent Git
  object and repository-state verification;
- logs, artifacts, or outputs are complete or safe;
- a coordinator or provider is secure, uncompromised, or consistently honest;
- a domain will remain under the same operator; or
- an identity with no known context is malicious.

The absence of evidence should be described as **No known trust context** or a
specific narrow statement such as **Not maintainer-requested**. It should not be
described as **untrusted**, **unsafe**, or **fraudulent** without separate
evidence.

## Reference Summary

| Level | Name                     | Core evidence                                                                                                                     | Claim it supports                                                           |
| ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1     | Maintainer-directed      | Verified maintainer Service Request, Manual Trigger, or active-at-run control history                                             | A maintainer explicitly requested the service or run                        |
| 2     | Operationally associated | Repository-listed GRASP infrastructure, verified domain/operator association, coordinator allocation, or accepted provider result | The repository or coordinator chose to use this infrastructure or provider  |
| 3     | Seen in your network     | Started or completed CI activity on repositories maintained by people the viewer follows                                          | This identity has prior CI activity on repositories in the viewer's network |

The levels describe evidence, not a numeric security score. A complete CI trust
context should retain the identities, signed events, domain checks, provenance,
time scope, and wording that justify every claim.
