import fs from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/)
    .map((line) => line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim().replace(/^['"]|['"]$/g, "")]),
);
const apiKey = env.VITE_FIREBASE_API_KEY;
const projectId = env.VITE_FIREBASE_PROJECT_ID;
if (!apiKey || !projectId) throw new Error("Firebase client configuration is missing");

const authUrl = (method) => `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${encodeURIComponent(apiKey)}`;
const firestoreBase = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
const users = [];
const createdDocs = [];

async function request(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

async function signUp(label) {
  let result = await request(authUrl("signUp"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!result.ok) {
    const suffix = crypto.randomBytes(8).toString("hex");
    result = await request(authUrl("signUp"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `lohz-rules-${label}-${suffix}@example.com`,
        password: `L0hz-${crypto.randomBytes(18).toString("base64url")}!`,
        returnSecureToken: true,
      }),
    });
  }
  if (!result.ok || !result.body?.idToken || !result.body?.localId) {
    throw new Error(`temporary Firebase Auth signup unavailable (${result.status})`);
  }
  const user = { uid: result.body.localId, token: result.body.idToken };
  users.push(user);
  return user;
}

const authHeaders = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const docUrl = (uid, collection, id) => `${firestoreBase}/users/${encodeURIComponent(uid)}/${collection}/${encodeURIComponent(id)}`;

async function writeDoc(user, collection, id, fields) {
  const url = docUrl(user.uid, collection, id);
  const result = await request(url, { method: "PATCH", headers: authHeaders(user.token), body: JSON.stringify({ fields }) });
  if (result.ok) createdDocs.push({ user, url });
  return result;
}

try {
  const alice = await signUp("a");
  const bob = await signUp("b");
  const plan = await writeDoc(alice, "plans", "live-rule-probe", {
    userId: { stringValue: alice.uid }, status: { stringValue: "ready" },
  });
  const ownRead = await request(docUrl(alice.uid, "plans", "live-rule-probe"), { headers: authHeaders(alice.token) });
  const crossRead = await request(docUrl(alice.uid, "plans", "live-rule-probe"), { headers: authHeaders(bob.token) });
  const guestRead = await request(docUrl(alice.uid, "plans", "live-rule-probe"));
  const forgedPlan = await writeDoc(alice, "plans", "live-rule-forged", {
    userId: { stringValue: bob.uid }, status: { stringValue: "ready" },
  });
  const lease = await writeDoc(alice, "leases", "live-lease-probe", {
    uid: { stringValue: alice.uid }, planId: { stringValue: "live-lease-probe" },
    requestId: { stringValue: "live-request" }, acquiredAt: { integerValue: "1" },
    expiresAt: { integerValue: "2" }, version: { integerValue: "1" },
  });

  const checks = {
    authenticatedOwnWrite: plan.status,
    authenticatedOwnRead: ownRead.status,
    crossUserReadDenied: crossRead.status,
    unauthenticatedReadDenied: guestRead.status,
    forgedOwnerWriteDenied: forgedPlan.status,
    leaseWriteAllowed: lease.status,
  };
  const passed = plan.ok && ownRead.ok && crossRead.status === 403 && guestRead.status === 403
    && forgedPlan.status === 403 && lease.ok;
  console.log(JSON.stringify({ projectId, passed, checks }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  for (const { user, url } of createdDocs.reverse()) {
    await request(url, { method: "DELETE", headers: authHeaders(user.token) });
  }
  for (const user of users.reverse()) {
    await request(authUrl("delete"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: user.token }),
    });
  }
}
