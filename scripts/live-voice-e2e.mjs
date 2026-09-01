import fs from "node:fs";
import WebSocket from "ws";

const pcmPath = process.argv[2];
if (!pcmPath || !fs.existsSync(pcmPath)) throw new Error("16 kHz mono PCM input file is required");
const pcm = fs.readFileSync(pcmPath);
const ws = new WebSocket("ws://127.0.0.1:3000/live?token=dev:voice-e2e-user");
const observed = { connected: false, inputTranscript: "", outputTranscript: "", cognitive: null, audioChunks: 0, turnComplete: false };

const timeout = setTimeout(() => {
  console.error(JSON.stringify({ passed: false, reason: "timeout", observed }, null, 2));
  ws.terminate();
  process.exitCode = 1;
}, 45_000);

function finishIfReady() {
  if (!observed.connected || !observed.inputTranscript || !observed.cognitive || observed.audioChunks === 0 || !observed.outputTranscript || !observed.turnComplete) return;
  clearTimeout(timeout);
  const keywords = (value) => new Set(String(value || "").toLowerCase().match(/[a-z]{6,}/g) || []);
  const cognitiveWords = keywords(observed.cognitive.response);
  const spokenWords = keywords(observed.outputTranscript);
  const topicOverlap = [...cognitiveWords].filter((word) => spokenWords.has(word));
  const passed = observed.cognitive.success === true && topicOverlap.length > 0;
  console.log(JSON.stringify({
    passed,
    connected: observed.connected,
    inputTranscript: observed.inputTranscript.slice(0, 200),
    outputTranscript: observed.outputTranscript.slice(0, 300),
    cognitive: {
      success: observed.cognitive.success,
      tier: observed.cognitive.tier,
      intent: observed.cognitive.intent,
      responsePresent: Boolean(observed.cognitive.response),
      responseType: typeof observed.cognitive.response,
      responsePreview: String(observed.cognitive.response || "").slice(0, 180),
    },
    spokenCognitiveTopicOverlap: topicOverlap.slice(0, 10),
    audioChunks: observed.audioChunks,
    turnComplete: observed.turnComplete,
  }, null, 2));
  ws.close();
  if (!passed) process.exitCode = 1;
}

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "status" && message.status === "connected") {
    observed.connected = true;
    void (async () => {
      const chunkBytes = 3_200;
      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        ws.send(JSON.stringify({ audio: pcm.subarray(offset, offset + chunkBytes).toString("base64") }));
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      const silence = Buffer.alloc(chunkBytes);
      for (let i = 0; i < 18; i += 1) {
        ws.send(JSON.stringify({ audio: silence.toString("base64") }));
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
    })();
  }
  if (message.type === "transcription" && message.role === "user") observed.inputTranscript += `${message.text} `;
  if (message.type === "transcription" && message.role === "model") observed.outputTranscript += `${message.text} `;
  if (message.type === "voice_cognitive_result") observed.cognitive = message;
  if (message.type === "audio") observed.audioChunks += 1;
  if (message.type === "turnComplete") observed.turnComplete = true;
  if (message.type === "error") {
    clearTimeout(timeout);
    console.error(JSON.stringify({ passed: false, error: message.error, observed }, null, 2));
    ws.close();
    process.exitCode = 1;
  }
  finishIfReady();
});

ws.on("error", (error) => {
  clearTimeout(timeout);
  console.error(JSON.stringify({ passed: false, error: error.message }, null, 2));
  process.exitCode = 1;
});
