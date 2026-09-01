# Phase 38 — Skill Acquisition & Versioned Skill Library (Architecture)

Date: 2026-09-01 · Status vocabulary: mandated spec fields marked **[spec]**; Phase-36 machinery reused unchanged where noted.

---

## 1. Position relative to Phase 36

Phase 36 delivered the acquisition pipeline
(`experience → candidate → validate → replay → approval → promoted`) over
`src/lib/learning/`. Phase 38 does **not** duplicate it. It adds the layer
that phase explicitly left open ("CognitiveRouter does not autonomously
invoke a learned skill… Selection is an explicit authenticated API
operation"):

1. **The mandated public `Skill` schema** as a library facade over the
   existing store (`src/lib/skills/`).
2. **Planner-integrated skill selection** for free-form objectives.
3. **Tool-registry drift versioning** (degradation → candidate v2).
4. **Declarative input parameterization** (`inputSchema` + `${arg}`
   placeholders on captured arguments).

## 2. Skill schema (as mandated)

`SkillLibrary.get/list` returns records shaped exactly as the spec:

```ts
Skill {
  skillId: string;      // stable id shared with the underlying SkillVersion
  name: string;
  description: string;
  version: number;
  inputSchema: SkillInputSchema | null;
  planTemplate: { steps: SkillStep[] };
  riskProfile: SkillRiskProfile;      // maximumRisk / tools / requiresConfirmation / policyMutable:false
  ownerUserId: string;
  status: "candidate" | "verified" | "active" | "degraded" | "deprecated";
  successCount: number;               // verified source experiences
  failureCount: number;               // failed source experiences
  createdAt: string;                  // ISO-8601
  updatedAt: string;                  // ISO-8601, bumped on every mutation
}
```

Note: the spec's status list (`candidate | verified | active |
deprecated`) is extended with **`degraded`** because the versioning section
requires it explicitly ("skill v1 → validation failure → skill marked
degraded"). Vocabulary mapping against the underlying store:

| `SkillVersion.status` (Phase 36 storage) | `Skill.status` (library) |
|---|---|
| `candidate` | `candidate` |
| `validated` / `replay_verified` / `pending_approval` | `verified` |
| `promoted` | `active` |
| `unreliable` / `degraded` | `degraded` |
| `rejected` / `retired` | `deprecated` |

## 3. Acquisition pipeline (unchanged, composed)

```text
authorized executions (Tier 0 via authorizedToolExecutor / Tier 3 via planner seam)
  → ExperienceBuilder.capture            (verified observation join only)
  → SkillLearningService.ingestExperience
  → detectCandidates (signature grouping, ≥3 verified identical-fingerprint samples)
  → validate   (stepGraph bounds + catalog + inputSchema + placeholder scan)
  → replay     (stable fingerprint equality vs sources)
  → requestApproval → approve (auth uid + exact approval id)
  → promoted   (library: "active")
```

Nothing is ever auto-active. Approval still requires
`authenticatedUserId === owner` + exact `approvalRequestId`.

## 4. Input parameterization (`learning/inputs.ts`)

- `inputSchema` (≤8 entries, keys `^[a-z][\w]{0,31}$`, closed types
  `string | integer | boolean | enum`, bounded enums ≤12, type-matched
  defaults). Validated in `validateSkillCandidate` — bad schemas reject
  the candidate.
- Placeholders are whole-argument values of the exact shape `"${name}"`.
  A string merely *containing* `${` is a `partial_placeholder` and is
  rejected at validation time. Every full placeholder must be declared in
  the schema (`undeclared_placeholder` otherwise — enforced even when
  `inputSchema` is `null`).
- At execution, `SkillExecutor` resolves placeholders from `inputs` →
  else declared defaults → missing required inputs fail closed with
  `invalid_skill_inputs`. Unknown input keys are rejected.
- Parameter resolution never touches non-placeholder arguments — those
  were verified at acquisition time and are passed through byte-identical.

## 5. Planner selection (skills are consulted, never authoritative)

`HierarchicalPlanner` gained one optional dependency:

```ts
skills?: { matchPlan: (uid, objective) => Promise<{ plan; skillId; version } | null> }
```

Run **only when stage-1 deterministic decomposition cannot express the
request** (i.e., exactly where the model-assisted stage would otherwise
start). Properties:

- Deterministic selection: token overlap between the objective and each
  promoted skill's `trigger.objectiveTokens`; requires ≥3 matched tokens
  and coverage ≥ 0.5; latest version wins ties.
- Only `promoted` skills whose `requiredContext.environment` matches are
  eligible. Degraded/deprecated skills are invisible here.
- A returned plan is a **normal plan**: `finalize()` runs the usual
  `validatePlan` gate and the confidence gate; execution flows through the
  existing `PlanExecutionEngine` with normal policy, observation, and
  recovery. `modelCallsUsed = 0`.
- Provenance marker `skill_source:<skillId>@v<version>` is embedded in
  `plan.constraints` so the server wiring can feed the outcome back into
  reliability accounting.
- Skill failure/exception in the seam falls through to the normal model
  stage. Skill bugs can never break generic planning.

## 6. Registry-drift versioning (never silent mutation)

Each skill records, per referenced tool, a deterministic fingerprint of
`{name, risk, parameterSchema}` (sha256, whitelisted structural fields —
function bodies deliberately excluded).

`SkillLibrary.revalidateAgainstRegistry(uid)`:

```text
for each promoted version:
  tool missing from registry        → degraded (reason tool_removed:<tool>)
  recorded fingerprint ≠ current    → degraded (reason tool_changed:<tool>)
  then queue ONE candidate v2 for that version (guarded against repeats)
```

A degraded version keeps its step graph immutable. The v2 candidate starts
the full pipeline from scratch (validate → replay → human approval →
promote). If the referenced tool is gone, v2 stays candid (validate fails
with `unknown_tool`) until a human revises it — honest, never fake.

`deprecate(uid, skillId, version)` transitions
`promoted|unreliable|degraded → retired` (library: "deprecated").

## 7. Security invariants (all enforced, all tested)

- Selection ≠ authorization. Medium/high-risk steps still require an
  out-of-band confirmation; destructive/critical still rejected.
- Ownership is bound at every store call; cross-user reads return null
  and cross-user mutations fail closed.
- Skills contain no code, prompts, or policy fields. `policyMutable:false`
  re-asserted at validation. Security-domain keywords in text reject the
  candidate.
- Inputs are scalar-typed, bounded, and whitelisted; extra keys rejected.
- `updatedAt` + `degradation` are the ONLY new patch fields the store
  transition whitelist accepts; the step graph remains immutable.
- Reliability accounting deduplicates idempotent replays
  (`idempotent: true` outcomes are skipped).

## 8. Server surface (additive)

| Route | Purpose |
|---|---|
| `GET /api/skills/library` | list library view (latest version per skill) |
| `GET /api/skills/library/:skillId?version=` | single skill, library view |
| `POST /api/skills/library/:skillId/versions/:version/deprecate` | explicit deprecation |
| `POST /api/skills/revalidate` | registry-drift sweep (degrade + queue v2) |
| `POST /api/skills/:skillId/versions/:version/execute` | + optional bounded `inputs` object |

All routes are behind the same authenticated `/api` middleware; all
existing Phase-36 lifecycle routes are unchanged.

## 9. What is intentionally NOT here

- No embeddings/semantic similarity (token overlap is honest and
  deterministic; Jaccard family only).
- No skill-to-skill composition (skills are a flat library).
- No automatic activation under any path (human approval gate retained).
- No runtime code synthesis in a skill (declarative data only).
- No mutation of a working skill — change happens only via `revise`
  (new candidate version) or `revalidateAgainstRegistry`
  (degrade + queued candidate).
