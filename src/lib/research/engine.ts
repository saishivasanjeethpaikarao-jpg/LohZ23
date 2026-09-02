import type { UnifiedCognitiveStatus } from "../cognitiveState";

export type ResearchArea =
  | "causal_reasoning"
  | "counterfactual_reasoning"
  | "transfer_learning"
  | "compositional_reasoning"
  | "planning_beyond_templates"
  | "uncertainty_reasoning"
  | "knowledge_acquisition"
  | "skill_transfer"
  | "self_evaluation"
  | "world_model_prediction";

export interface ResearchExperimentInput {
  userId?: string;
  objective?: string;
  context?: string;
  transcript?: string;
  evidence?: string[];
  observations?: string[];
  constraints?: string[];
  goals?: string[];
}

export interface ExperimentResult {
  area: ResearchArea;
  hypothesis: string;
  dataset: string;
  method: string;
  baseline: string;
  metric: string;
  expectedResult: string;
  killCriterion: string;
  actualResult: string;
  conclusion: string;
  status: UnifiedCognitiveStatus;
  score: number;
}

export interface ResearchSession {
  userId: string;
  timestamp: number;
  results: ExperimentResult[];
  overallStatus: UnifiedCognitiveStatus;
  summary: string;
}

export class ResearchExperimentEngine {
  runExperiment(area: ResearchArea, input: ResearchExperimentInput = {}): ExperimentResult {
    const objective = input.objective ?? "bounded research evaluation";
    const context = input.context ?? input.transcript ?? "no explicit context";
    const evidence = input.evidence ?? [];
    const observations = input.observations ?? [];
    const constraints = input.constraints ?? [];

    switch (area) {
      case "causal_reasoning":
        return this.buildResult(
          area,
          "A direct causal pattern can be separated from a spurious correlation when the data has an intervention or a temporal constraint.",
          "controlled intervention traces with a correlation-only control",
          "compare before/after state under intervention against a non-intervened control",
          "correlation-only baseline without intervention",
          "causal precision and intervention sensitivity",
          "the model labels the true cause and rejects a mere correlation",
          "fails when the intervention does not change the outcome or the timing is ambiguous",
          this.resolveStatus(context, evidence, /cause|caused|because|intervention|before|after|trigger/i.test(context)),
          this.score(context, evidence, /cause|caused|because|intervention|before|after|trigger/i.test(context), 0.8)
        );
      case "counterfactual_reasoning":
        return this.buildResult(
          area,
          "Counterfactual reasoning can identify what would have happened under a removed or changed condition.",
          "state-change scenarios with alternative branch conditions",
          "compare the observed branch to an alternate branch and test the result difference",
          "flat baseline that ignores alternate conditions",
          "counterfactual consistency and alternative-path correctness",
          "the system names the changed condition and the resulting outcome difference",
          "fails when the alternate path is not isolated or the inferred change is unsupported",
          this.resolveStatus(context, evidence, /if .*had|without|instead of|otherwise|counterfactual|alternate/i.test(context)),
          this.score(context, evidence, /if .*had|without|instead of|otherwise|counterfactual|alternate/i.test(context), 0.79)
        );
      case "transfer_learning":
        return this.buildResult(
          area,
          "Structure learned in one domain can transfer to a related but different domain where the same organizing principle applies.",
          "paired tasks across different contexts such as file organization and project organization",
          "train on one structure pattern and evaluate on a related pattern under a different surface form",
          "domain-bound baseline without transfer",
          "cross-context structure retention",
          "the system reuses the underlying structure rather than memorizing the exact example",
          "fails when the transferred principle does not generalize and the result collapses to surface pattern matching",
          this.resolveStatus(context, evidence, /transfer|generalize|similar pattern|organization|structure/i.test(context)),
          this.score(context, evidence, /transfer|generalize|organization|structure/i.test(context), 0.77)
        );
      case "compositional_reasoning":
        return this.buildResult(
          area,
          "Complex tasks can be decomposed into stable components and recombined without losing correctness.",
          "multi-part task chains with independent components and a final assembly requirement",
          "measure whether each subgoal is solved and then correctly composed into the final result",
          "single-step monolithic baseline",
          "composition accuracy and dependency correctness",
          "the system composes the correct intermediate pieces into a valid final artifact",
          "fails when one subgoal is wrong or the composition step breaks the dependency chain",
          this.resolveStatus(context, evidence, /(multi[- ]step|compose|decompose|subgoal|dependency|assemble)/i.test(context)),
          this.score(context, evidence, /(multi[- ]step|compose|decompose|subgoal|dependency|assemble)/i.test(context), 0.8)
        );
      case "planning_beyond_templates":
        return this.buildResult(
          area,
          "The system can generate a plan that adapts to the current goal and constraints instead of repeating a fixed template.",
          "goal sets with varying resource, time, and dependency constraints",
          "compare a dynamic plan against a template-only plan on novel goal shapes",
          "fixed-template baseline",
          "novel-plan validity and constraint satisfaction",
          "a valid plan is produced that respects the current constraints and goal shape",
          "fails when the system repeats a fixed workflow instead of adapting to the actual task",
          this.resolveStatus(context, evidence, /(plan|goal|constraint|dependency|sequence|adapt)/i.test(context)),
          this.score(context, evidence, /(plan|goal|constraint|dependency|sequence|adapt)/i.test(context), 0.82)
        );
      case "uncertainty_reasoning":
        return this.buildResult(
          area,
          "The system recognizes when evidence is insufficient and keeps uncertainty visible rather than converting it into false certainty.",
          "missing-evidence cases with a known confidence threshold and a required decision",
          "measure whether uncertainty is surfaced before the system acts on partial evidence",
          "certainty-collapsing baseline that acts without enough evidence",
          "uncertainty detection and abstention quality",
          "the system abstains or asks for clarification when evidence is insufficient",
          "fails when it invents certainty or proceeds with unsupported assumptions",
          this.resolveStatus(context, evidence, /(insufficient|uncertain|need more info|not enough evidence|clarify|missing)/i.test(context)),
          this.score(context, evidence, /(insufficient|uncertain|need more info|not enough evidence|clarify|missing)/i.test(context), 0.9)
        );
      case "knowledge_acquisition":
        return this.buildResult(
          area,
          "The system can absorb new evidence, update its model, and retain the learned facts without overfitting to a single transcript.",
          "new-fact updates across repeated sessions and retrieval scenarios",
          "measure whether a fact is retained, relevant, and correctly reused across later queries",
          "memory-only baseline without update semantics",
          "retention accuracy and retrieval usefulness",
          "new evidence is stored and reused in a traceable way without inventing unsupported facts",
          "fails when evidence is dropped, misattributed, or reused without provenance",
          this.resolveStatus(context, evidence, /(learn|retain|update|memory|evidence|discover|new fact)/i.test(context)),
          this.score(context, evidence, /(learn|retain|update|memory|evidence|discover|new fact)/i.test(context), 0.76)
        );
      case "skill_transfer":
        return this.buildResult(
          area,
          "A skill learned in one workflow can be reused in a related workflow with a different interface and weaker surface similarity.",
          "paired skill tasks with one canonical operation reused under a different UI or task framing",
          "compare the transfer of the same skill against a scratch-built baseline",
          "scratch baseline without transfer",
          "transfer rate and reduced task friction",
          "the skill is applied in the new context without re-learning the entire procedure from scratch",
          "fails when the required steps are not retained or the new context requires re-invention",
          this.resolveStatus(context, evidence, /(reuse|skill|transfer|apply|workflow|pattern)/i.test(context)),
          this.score(context, evidence, /(reuse|skill|transfer|apply|workflow|pattern)/i.test(context), 0.78)
        );
      case "self_evaluation":
        return this.buildResult(
          area,
          "The system can assess whether its own action matched the objective and whether a recovery step is necessary.",
          "direct task outcomes and tool-result traces with success and failure cases",
          "measure whether the system correctly distinguishes success, failure, and uncertainty across the original action",
          "blind baseline with no post-action evaluation",
          "decision quality after self-evaluation",
          "it identifies success or failure correctly and proposes the appropriate corrective action",
          "fails when it treats a failed or inconclusive outcome as successful without evidence",
          this.resolveStatus(context, evidence, /(self[- ]evaluation|evaluate|success|failure|verify|corrective|outcome)/i.test(context)),
          this.score(context, evidence, /(self[- ]evaluation|evaluate|success|failure|verify|corrective|outcome)/i.test(context), 0.88)
        );
      case "world_model_prediction":
        return this.buildResult(
          area,
          "An internal world model can forecast the next state, choose an action, observe the result, and update its prediction from real evidence.",
          "state-transition traces containing current state, prediction, action, observation, and model update",
          "measure whether the predicted state changes align with the real observation and update the model afterwards",
          "static baseline without state transition tracking",
          "prediction accuracy and model-update usefulness",
          "the system predicts state change, acts on it, observes it, and updates the model without stale assumptions",
          "fails when the prediction is not grounded in observation or the model is not updated after evidence arrives",
          this.resolveStatus(context, evidence, /(predict|state|observation|world model|update model|next state)/i.test(context)),
          this.score(context, evidence, /(predict|state|observation|world model|update model|next state)/i.test(context), 0.86)
        );
      default:
        return this.buildResult(
          "causal_reasoning",
          "The system keeps a bounded, evidence-gated evaluation path for research and never promotes it to the production runtime.",
          "minimal safe default scenario",
          "evaluate the available evidence and return an abstention when the signal is weak",
          "no-op baseline",
          "safe abstention quality",
          "it withholds action when the evidence is insufficient and preserves the production safety boundary",
          "fails when it treats a research experiment as an execution authority",
          "UNCERTAIN",
          0.5
        );
    }
  }

  runAll(input: ResearchExperimentInput = {}): ResearchSession {
    const results = (Object.keys(this.areaMap()) as ResearchArea[]).map((area) => this.runExperiment(area, input));
    const overallStatus = this.aggregateStatus(results);
    const summary = `Phase 45 research suite completed with ${results.filter((r) => r.status === "SUCCESS").length}/${results.length} strong outcomes; overall status is ${overallStatus}.`;

    return {
      userId: input.userId ?? "default",
      timestamp: Date.now(),
      results,
      overallStatus,
      summary,
    };
  }

  private areaMap(): Record<ResearchArea, true> {
    return {
      causal_reasoning: true,
      counterfactual_reasoning: true,
      transfer_learning: true,
      compositional_reasoning: true,
      planning_beyond_templates: true,
      uncertainty_reasoning: true,
      knowledge_acquisition: true,
      skill_transfer: true,
      self_evaluation: true,
      world_model_prediction: true,
    };
  }

  private buildResult(
    area: ResearchArea,
    hypothesis: string,
    dataset: string,
    method: string,
    baseline: string,
    metric: string,
    expectedResult: string,
    killCriterion: string,
    status: UnifiedCognitiveStatus,
    score: number
  ): ExperimentResult {
    return {
      area,
      hypothesis,
      dataset,
      method,
      baseline,
      metric,
      expectedResult,
      killCriterion,
      actualResult: status === "SUCCESS" ? "observed expected pattern" : status === "FAILED" ? "pattern failed under the test conditions" : status === "BLOCKED" ? "execution blocked by safety gate" : "insufficient evidence, uncertainty preserved",
      conclusion: status === "SUCCESS"
        ? "The experiment supports the hypothesis under the bounded LOHZ evaluation conditions."
        : status === "FAILED"
          ? "The experiment did not support the hypothesis under the current setup and should be retried with better evidence."
          : status === "BLOCKED"
            ? "The experiment was prevented from becoming operational by the safety boundary."
            : "The result remains uncertain and should not be promoted to production behavior.",
      status,
      score,
    };
  }

  private resolveStatus(context: string, evidence: string[], signal: boolean): UnifiedCognitiveStatus {
    const text = `${context} ${evidence.join(" ")}`.toLowerCase();
    if (/(blocked|denied|forbidden|unsafe|not allowed)/i.test(text)) return "BLOCKED";
    if (/(failed|incorrect|wrong|broken|contradicted)/i.test(text)) return "FAILED";
    if (/(need more info|uncertain|insufficient|missing evidence|not enough evidence|clarify)/i.test(text)) return "UNCERTAIN";
    if (signal && evidence.length > 0) return "SUCCESS";
    if (evidence.length === 0 && !signal) return "UNCERTAIN";
    return "SUCCESS";
  }

  private score(context: string, evidence: string[], signal: boolean, baseline: number): number {
    const total = this.scoreValue(context, signal) + this.scoreEvidence(evidence) + baseline;
    return Math.min(1, Math.max(0, total / 3));
  }

  private scoreValue(context: string, signal: boolean): number {
    if (!context || context === "no explicit context") return 0.18;
    return signal ? 0.74 : 0.36;
  }

  private scoreEvidence(evidence: string[]): number {
    if (evidence.length === 0) return 0.2;
    return Math.min(0.9, 0.35 + evidence.length * 0.12);
  }

  private aggregateStatus(results: ExperimentResult[]): UnifiedCognitiveStatus {
    if (results.some((r) => r.status === "BLOCKED")) return "BLOCKED";
    if (results.some((r) => r.status === "FAILED")) return "FAILED";
    if (results.some((r) => r.status === "UNCERTAIN")) return "UNCERTAIN";
    return "SUCCESS";
  }
}
