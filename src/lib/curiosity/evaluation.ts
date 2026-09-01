/**
 * Phase 42 — OFFLINE evaluation harness.
 *
 * Research instrument, not production logic. Replays scripted scenarios
 * through CuriosityService with deterministic stub providers and measures:
 *
 *   unnecessaryQuestions — asked the user when a free source had the answer
 *   usefulQuestions      — the user's answer actually resolved the gap
 *   uncertaintyReduction — mean initial→final uncertainty drop (resolved gaps)
 *   incorrectAssumptions — low-importance memory-only resolution where the
 *                          oracle marks the memory as WRONG (policy allows
 *                          only partial, low-stakes resolution → 0 expected)
 *   actionAvoidance      — recommendation was `withhold` when no safe source
 *                          exists (insufficient-information abstention)
 *
 * The harness NEVER executes tools and NEVER calls a model.
 */
import { CuriosityService } from "./service";
import { InMemoryCuriosityStore } from "./store";
import type { GapDetectionInput } from "./detection";

export interface EvalScenario {
  id: string;
  input: GapDetectionInput;
  providers: {
    memoryHasAnswer?: boolean;
    /** Fixed-in-advance oracle: the memory answer is actually correct. */
    memoryAnswerTruthful?: boolean;
    worldHasAnswer?: boolean;
    probeSafe?: boolean;
  };
  oracle?: {
    userAnswerTruthful?: boolean;
    answerResolves?: boolean;
  };
}

export interface EvalMetrics {
  scenarios: number;
  gaps: number;
  questionsAsked: number;
  unnecessaryQuestions: number;
  usefulQuestions: number;
  uncertaintyReduction: number;
  incorrectAssumptions: number;
  actionAvoidance: number;
}

export interface EvalRun {
  metrics: EvalMetrics;
  perScenario: Array<{
    id: string;
    action: string;
    initialUncertainty: number;
    finalUncertainty: number;
    resolved: boolean;
  }>;
}

export async function runCuriosityEvaluation(scenarios: EvalScenario[], opts: { now?: () => number } = {}): Promise<EvalRun> {
  const per: EvalRun["perScenario"] = [];
  let unnecessaryQuestions = 0;
  let usefulQuestions = 0;
  let reductionSum = 0;
  let reductionCount = 0;
  let incorrectAssumptions = 0;
  let actionAvoidance = 0;
  let questionsAsked = 0;
  let gaps = 0;

  for (const scenario of scenarios) {
    const store = new InMemoryCuriosityStore();
    const service = new CuriosityService({
      store,
      providers: {
        hasRelevantMemory: async () => scenario.providers.memoryHasAnswer === true,
        hasCurrentWorldFact: async () => scenario.providers.worldHasAnswer === true,
        probeIsSafe: () => scenario.providers.probeSafe !== false,
      },
      now: opts.now ?? (() => 1_000_000),
    });

    const uid = "eval-user";
    const gap = await service.captureRouteOutcome(uid, scenario.input);
    if (!gap) {
      per.push({ id: scenario.id, action: "none", initialUncertainty: 0, finalUncertainty: 0, resolved: false });
      continue;
    }
    gaps += 1;
    const initialUncertainty = gap.uncertainty;

    const rec = await service.recommend(uid, gap.gapId);
    const action = rec?.action ?? "withhold";

    if (action === "withhold") {
      actionAvoidance += 1;
    } else if (action === "ask_user") {
      questionsAsked += 1;
      if (scenario.providers.memoryHasAnswer || scenario.providers.worldHasAnswer) unnecessaryQuestions += 1;
      if (scenario.oracle?.answerResolves) {
        await service.resolveWithUserAnswer(uid, gap.gapId, "oracle answer");
        if (scenario.oracle.userAnswerTruthful !== false) usefulQuestions += 1;
      }
    } else if (action === "use_memory") {
      await service.applyMemoryHit(uid, gap.gapId, "memory hit");
      if (scenario.providers.memoryAnswerTruthful === false) {
        // Missed-correction path: low-importance gaps can partially resolve
        // via memory; if the oracle says that memory was WRONG, that was an
        // incorrect assumption.
        const after = await readGap(service, store, uid, gap.gapId);
        if (after?.status === "resolved") incorrectAssumptions += 1;
      }
    } else if (action === "safe_probe" || action === "inspect_state") {
      await service.resolveWithEvidence(uid, gap.gapId, `verified via ${action}`);
    }

    const finalGap = await readGap(service, store, uid, gap.gapId);
    const finalUncertainty = finalGap?.uncertainty ?? initialUncertainty;
    const resolved = finalGap?.status === "resolved";
    if (resolved && finalUncertainty < initialUncertainty) {
      reductionSum += initialUncertainty - finalUncertainty;
      reductionCount += 1;
    }
    per.push({ id: scenario.id, action, initialUncertainty, finalUncertainty, resolved });
  }

  return {
    metrics: {
      scenarios: scenarios.length,
      gaps,
      questionsAsked,
      unnecessaryQuestions,
      usefulQuestions,
      uncertaintyReduction: reductionCount ? reductionSum / reductionCount : 0,
      incorrectAssumptions,
      actionAvoidance,
    },
    perScenario: per,
  };
}

async function readGap(service: CuriosityService, store: InMemoryCuriosityStore, uid: string, gapId: string) {
  const openList = await service.listOpen(uid);
  const hit = openList.find((item) => item.gapId === gapId);
  if (hit) return hit;
  return store.getGap(uid, gapId);
}
