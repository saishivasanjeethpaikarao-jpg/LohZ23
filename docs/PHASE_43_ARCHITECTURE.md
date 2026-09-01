# LOHZ Phase 43 Architecture — Controlled Code Change Proposals

## Scope

Phase 43 adds a controlled, human-approved code-change proposal lifecycle. It is not an unrestricted shell, deployment system, autonomous self-modifier, second planner, or replacement for the existing authentication and execution architecture.

```text
authenticated administrator
  -> bounded repository inspection
  -> diagnosis and affected-file evidence
  -> structured exact-text patch proposal
  -> static security policy
  -> isolated temporary repository copy
  -> fixed test / typecheck / build checks
  -> digest-bound human approval
  -> explicit apply acknowledgement
  -> live-file hash and hunk revalidation
  -> controlled patch application
  -> immutable audit transition
```

There is deliberately no deployment endpoint.

## Controlled repository interface

`ControlledRepository` exposes only bounded operations:

- read an allowlisted source, test, configuration, or documentation file;
- literal symbol search with capped query length and result count;
- static, dynamic, and CommonJS dependency relationship discovery;
- test-file discovery;
- bounded build-output and error-log artifacts;
- affected-file ranking using path, filename, content, diagnostic, and reverse-import evidence;
- preview and apply structured create/update patches.

Allowed repository roots are `src`, `server`, `windows-agent`, `docs`, and `scripts`, plus a small allowlist of root project files. Credentials, `.env` files, `.git`, dependency directories, build output, persistent data, traversal targets, and paths escaping through symlinks or junctions are unavailable. Reads are size bounded. There is no arbitrary filesystem API and no delete-file patch operation.

Every existing path component is resolved before access. This prevents an allowed-looking child path from escaping through a parent directory junction.

## Proposal model and lifecycle

A `CodeChangeProposal` records:

- owner UID, proposal ID, version, revision, and schema version;
- bug-fix or feature kind;
- requirement, reason, diagnosis, and root-cause hypothesis;
- affected file references and SHA-256 hashes;
- dependency evidence;
- exact structured patches and declared tests;
- security evaluation and fixed verification runs;
- approval request, approver, timestamps, and digest;
- creation, update, and apply timestamps.

Lifecycle states are:

```text
proposed
  -> sandbox_verified | verification_failed
  -> pending_approval
  -> approved | rejected
  -> applying
  -> applied | apply_failed
```

Every transition is compare-and-set and written atomically with an immutable audit event. New proposal content creates a new version. A crash after entering `applying` is not blindly resumed; it requires operator review.

## Patch representation

Patches are data, not code runners:

```ts
interface ProposedFilePatch {
  path: string;
  operation: "create" | "update";
  expectedSha256: string | null;
  hunks: Array<{ oldText: string; newText: string }>;
}
```

An update requires the captured file hash and each old-text hunk to occur exactly once. Creation requires a previously absent target. Patch JSON is normalized at the service boundary and malformed shapes fail closed.

## Security policy

The static policy rejects proposals that:

- touch authentication, authorization, credentials, execution guards, cognitive guards, Firestore rules, tool validation, project/test configuration, the self-coding kernel, or verification scripts;
- modify an existing test instead of adding a regression test;
- omit a test patch or test description;
- add process spawning, dynamic code evaluation, shell execution, environment/credential reads, arbitrary filesystem access, verification suppression, disabled tests, permissive security rules, or named security bypasses;
- exceed bounded patch, hunk, text, or proposal limits.

This policy is re-evaluated at proposal creation, verification, and application. The engine itself cannot use its proposal path to rewrite these controls.

## Sandbox verification

`FixedSandboxExecutor` builds an OS-temporary private copy containing only repository-allowlisted files and a copied dependency snapshot. It applies the patch there and accepts only enum-selected checks mapped by code to fixed commands:

- tests: `npm test -- --pool=forks --maxWorkers=1`
- typecheck: `npm run lint` (`tsc --noEmit` in this repository)
- build: `npm run build`
- security: the static policy result

The child process uses `shell: false`, a credential-free environment allowlist, hidden Windows execution, bounded output, and a five-minute timeout. Proposal text never becomes a command, executable, argument, or environment variable. The temporary directory is removed after the run.

## Approval and application

Verification success alone cannot apply a patch. Approval requires:

1. all four fixed checks to pass;
2. an explicit approval request;
3. a matching one-time approval request ID;
4. the authenticated proposal owner;
5. `approved: true`;
6. a digest binding proposal content, security result, and verification output digests.

Application is a distinct action requiring `applyApprovedPatch: true`. Immediately before applying, LOHZ re-runs policy, recomputes the approval digest, verifies all affected source hashes, previews every exact hunk, and atomically claims the `applying` state. Multi-file filesystem rollback is best effort if an I/O failure occurs.

## Persistence and concurrency

- `FirestoreSelfCodingStore` uses Firestore transactions for proposal-version heads and compare-and-set lifecycle transitions. Proposal and audit writes are atomic and user scoped.
- `LocalSelfCodingStore` uses atomic JSON replacement for restart-safe, single-host development fallback.
- `InMemorySelfCodingStore` is test-only.

Firestore paths are owner readable and server-write-only:

```text
users/{uid}/codeChangeProposals/{proposalVersionKey}
users/{uid}/codeChangeHeads/{proposalId}
users/{uid}/codeChangeAudit/{eventId}
```

## Authenticated API

All routes are under `/api/self-coding`, behind the existing fail-closed API authentication middleware and the existing credential-administrator UID allowlist. The API provides bounded inspection, diagnosis, proposal/version/audit reads, verification, approval request, approval, rejection, and explicit application. It provides no arbitrary shell and no deployment route.

## Request lifecycles

Bug flow:

```text
bounded error evidence
  -> deterministic diagnosis
  -> affected files and imports
  -> structured patch plus new regression test
  -> sandbox and human gate
```

Feature flow:

```text
bounded requirement
  -> architecture search
  -> affected files and dependencies
  -> versioned structured patch plus new tests
  -> sandbox and human gate
```

Patch generation may be performed by a separately controlled reasoning caller, but Phase 43 stores and evaluates only structured data. It does not grant a model shell or filesystem authority.

