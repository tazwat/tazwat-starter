// Run: npm test (from Web/functions). The cryptography is simplewebauthn's job; these tests cover our rules:
// one-time challenges, expiry, per-user challenges, guests refused, key limit, deleted accounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal: rk } = require("../api/restoreKeys");

function memoryStore() {
  const challenges = new Map();
  const keys = new Map();
  return {
    keys,
    createChallenge: async (id, data) => { challenges.set(id, data); },
    consumeChallenge: async (id) => { const c = challenges.get(id) || null; challenges.delete(id); return c; },
    getKey: async (id) => keys.get(id) || null,
    saveKey: async (id, data) => { keys.set(id, data); },
    updateKey: async (id, patch) => { keys.set(id, { ...keys.get(id), ...patch }); },
    deleteKey: async (id) => { keys.delete(id); },
    listKeys: async (uid) => [...keys].filter(([, k]) => k.uid === uid).map(([id, k]) => ({ id, ...k })),
  };
}

// Fake WebAuthn: options carry a fresh challenge; a "response" is { id, challenge } and verifies when the
// server accepts its challenge — exactly the part of verification our code controls.
function fakeWebauthn() {
  let n = 0;
  return {
    generateRegistrationOptions: async () => ({ challenge: `reg-${++n}` }),
    generateAuthenticationOptions: async () => ({ challenge: `auth-${++n}` }),
    verifyRegistrationResponse: async ({ response, expectedChallenge }) => {
      if (!await expectedChallenge(response.challenge)) throw new Error("Unexpected registration response challenge");
      return { verified: true, registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0 } } };
    },
    verifyAuthenticationResponse: async ({ response, expectedChallenge, credential }) => {
      if (!await expectedChallenge(response.challenge)) throw new Error("Unexpected authentication response challenge");
      assert.equal(credential.id, response.id);
      return { verified: true, authenticationInfo: { newCounter: 0 } };
    },
  };
}

function setup() {
  let clock = 1_000_000;
  const users = new Map([["alice", { disabled: false }], ["bob", { disabled: false }]]);
  const deps = {
    store: memoryStore(),
    webauthn: fakeWebauthn(),
    config: { rpID: "example.com", rpName: "Example", origins: ["android:apk-key-hash:abc"] },
    now: () => clock,
    auth: {
      getUser: async (uid) => {
        if (!users.has(uid)) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
        return users.get(uid);
      },
      createCustomToken: async (uid) => `token-for-${uid}`,
    },
  };
  return { deps, users, tick: (ms) => { clock += ms; } };
}

async function registerKey(deps, uid, id) {
  const { challenge } = await rk.registerOptions({ uid, signInProvider: "google.com" }, deps);
  return rk.register({ uid, response: { id, challenge } }, deps);
}

async function signInWith(deps, id) {
  const { challenge } = await rk.signInOptions(deps);
  return rk.signIn({ response: { id, challenge } }, deps);
}

test("a registered key signs its owner in", async () => {
  const { deps } = setup();
  await registerKey(deps, "alice", "key-a");
  assert.deepEqual(await signInWith(deps, "key-a"), { token: "token-for-alice" });
});

test("guests can't register a key", async () => {
  const { deps } = setup();
  await assert.rejects(rk.registerOptions({ uid: "alice", signInProvider: "anonymous" }, deps), { status: 403 });
});

test("a challenge works only once", async () => {
  const { deps } = setup();
  await registerKey(deps, "alice", "key-a");
  const { challenge } = await rk.signInOptions(deps);
  await rk.signIn({ response: { id: "key-a", challenge } }, deps);
  await assert.rejects(rk.signIn({ response: { id: "key-a", challenge } }, deps), { status: 400 });
});

test("an expired challenge is refused", async () => {
  const { deps, tick } = setup();
  await registerKey(deps, "alice", "key-a");
  const { challenge } = await rk.signInOptions(deps);
  tick(rk.CHALLENGE_TTL_MS + 1);
  await assert.rejects(rk.signIn({ response: { id: "key-a", challenge } }, deps), { status: 400 });
});

test("a user can't register with another user's challenge", async () => {
  const { deps } = setup();
  const { challenge } = await rk.registerOptions({ uid: "alice", signInProvider: "google.com" }, deps);
  await assert.rejects(rk.register({ uid: "bob", response: { id: "key-b", challenge } }, deps), { status: 400 });
});

test("a sign-in challenge can't register a key", async () => {
  const { deps } = setup();
  const { challenge } = await rk.signInOptions(deps);
  await assert.rejects(rk.register({ uid: "alice", response: { id: "key-a", challenge } }, deps), { status: 400 });
});

test("unknown keys are refused", async () => {
  const { deps } = setup();
  await assert.rejects(signInWith(deps, "nope"), { status: 404 });
});

test("only the newest keys are kept per user", async () => {
  const { deps, tick } = setup();
  for (let i = 0; i <= rk.MAX_KEYS_PER_USER; i++) {
    await registerKey(deps, "alice", `key-${i}`);
    tick(1);
  }
  await registerKey(deps, "bob", "key-bob");
  assert.equal((await deps.store.listKeys("alice")).length, rk.MAX_KEYS_PER_USER);
  assert.equal(await deps.store.getKey("key-0"), null);
  assert.ok(await deps.store.getKey("key-bob"));
});

test("a key of a deleted account is removed", async () => {
  const { deps, users } = setup();
  await registerKey(deps, "alice", "key-a");
  users.delete("alice");
  await assert.rejects(signInWith(deps, "key-a"), { status: 404 });
  assert.equal(await deps.store.getKey("key-a"), null);
});

test("a disabled account is refused", async () => {
  const { deps, users } = setup();
  await registerKey(deps, "alice", "key-a");
  users.set("alice", { disabled: true });
  await assert.rejects(signInWith(deps, "key-a"), { status: 403 });
});

test("a key still works years later (phones are kept for years)", async () => {
  const { deps, tick } = setup();
  await registerKey(deps, "alice", "key-a");
  tick(3 * 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await signInWith(deps, "key-a"), { token: "token-for-alice" });
});

test("config reads the origin list", () => {
  const c = rk.readConfig({ RESTORE_RP_ID: "example.com", RESTORE_ANDROID_ORIGINS: " a , b ,," });
  assert.deepEqual(c, { rpID: "example.com", rpName: "example.com", origins: ["a", "b"] });
});
