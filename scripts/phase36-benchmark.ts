import { performance } from "node:perf_hooks";
import { ConversationSession } from "../src/lib/conversation/session";
import { normalizeVoiceSpeaker } from "../src/lib/conversation/speakerNormalization";
import { decideResponseEligibility } from "../src/lib/conversation/responseEligibility";
import { TranscriptAccumulator } from "../src/lib/conversation/transcriptAccumulator";

const iterations = 10_000;
const samples: number[] = [];
const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const session = new ConversationSession("benchmark", "benchmark-user");
session.setMode("multi_person");

for (let i = 0; i < iterations; i += 1) {
  const started = performance.now();
  const normalized = normalizeVoiceSpeaker("multi_person", {
    speakerTag: `sim-${i % 3}`,
    confidence: 0.85,
    confidenceCalibrated: true,
  });
  const accumulator = new TranscriptAccumulator();
  accumulator.push({ text: "LOHZ,", finished: false });
  const final = accumulator.push({ text: `compare option ${i}`, finished: true });
  const turn = await session.addTurn({
    text: final!.text,
    source: "voice",
    provider: {
      speakerTag: normalized.speakerId,
      confidence: normalized.confidence.value,
      confidenceCalibrated: true,
    },
  });
  decideResponseEligibility("multi_person", turn);
  samples.push(performance.now() - started);
}

samples.sort((a, b) => a - b);
const percentile = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const cpu = process.cpuUsage(cpuBefore);
const heapAfter = process.memoryUsage().heapUsed;

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  iterations,
  workload: "speaker normalization + two transcript chunks + bounded session update + response gate",
  latencyMs: {
    median: Number(percentile(0.5).toFixed(4)),
    p95: Number(percentile(0.95).toFixed(4)),
    p99: Number(percentile(0.99).toFixed(4)),
  },
  cpuMs: {
    user: Number((cpu.user / 1000).toFixed(2)),
    system: Number((cpu.system / 1000).toFixed(2)),
  },
  heapDeltaBytes: heapAfter - heapBefore,
  retainedTurns: session.snapshot().recentSpeakerTurns.length,
  retainedSpeakers: session.snapshot().speakers.length,
  localDiarization: false,
  modelCallsAddedByMetadataLayer: 0,
  note: "Synthetic Node benchmark; not a microphone/provider end-to-end latency claim. Heap delta includes runtime allocation noise.",
}, null, 2));
