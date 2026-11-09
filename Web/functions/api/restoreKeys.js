// Restore keys (Google Play "Zero-Tap Sign-In", required from April 2027): the server half of the
// Android Restore Credentials API. The app registers a hidden WebAuthn key after a Google/Apple sign-in;
// on a new phone it sends that key back and gets a Firebase custom token, so the user is signed in again
// without tapping anything. Guide: skills/enable-restore-credentials/SKILL.md.
//
// Config (functions/.env): RESTORE_RP_ID (domain), RESTORE_ANDROID_ORIGINS (android:apk-key-hash:… list),
// optional RESTORE_RP_NAME. The endpoints are exported by index.js only when RESTORE_RP_ID is set.
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const webauthn = require("@simplewebauthn/server");
const { isoBase64URL, isoUint8Array } = require("@simplewebauthn/server/helpers");
const { sendApiResponse } = require("../utils/utils");
const Validation = require("../utils/validation");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_KEYS_PER_USER = 5; // one per device; the oldest goes when a 6th device registers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readConfig(env = process.env) {
  return {
    rpID: env.RESTORE_RP_ID,
    rpName: env.RESTORE_RP_NAME || env.RESTORE_RP_ID,
    origins: (env.RESTORE_ANDROID_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean),
  };
}

// --- storage: Firestore in production, a Map in tests -------------------------------------------

function firestoreStore(db = getFirestore()) {
  const challenges = db.collection("restoreChallenges");
  const keys = db.collection("restoreKeys");
  return {
    async createChallenge(id, data) {
      // expiresAt as a Date so a Firestore TTL policy on it can delete leftovers.
      await challenges.doc(id).set({ ...data, expiresAt: new Date(data.expiresAt) });
    },
    // Reads and deletes in one transaction: a challenge works once.
    async consumeChallenge(id) {
      const ref = challenges.doc(id);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        tx.delete(ref);
        const data = snap.data();
        return { ...data, expiresAt: data.expiresAt.toMillis() };
      });
    },
    async getKey(id) {
      const snap = await keys.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    saveKey: (id, data) => keys.doc(id).set(data),
    updateKey: (id, patch) => keys.doc(id).update(patch),
    deleteKey: (id) => keys.doc(id).delete(),
    async listKeys(uid) {
      const snap = await keys.where("uid", "==", uid).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
  };
}

// --- the four operations ------------------------------------------------------------------------

async function consume(deps, challenge, type, uid) {
  const c = await deps.store.consumeChallenge(challenge);
  return !!c && c.type === type && c.expiresAt > deps.now() && (uid === undefined || c.uid === uid);
}

// webauthn throws on a bad response (wrong origin, challenge, signature…): that's the client's fault.
async function verify(fn) {
  try {
    return await fn();
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

async function registerOptions({ uid, signInProvider }, deps) {
  // Guests have nothing to restore that a new guest account wouldn't give them.
  if (signInProvider === "anonymous") throw new HttpError(403, "Guest accounts don't get restore keys.");
  const { rpID, rpName } = deps.config;
  const options = await deps.webauthn.generateRegistrationOptions({
    rpName,
    rpID,
    userName: uid,
    userID: isoUint8Array.fromUTF8String(uid),
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  });
  await deps.store.createChallenge(options.challenge, { type: "register", uid, expiresAt: deps.now() + CHALLENGE_TTL_MS });
  return options;
}

async function register({ uid, response }, deps) {
  const { rpID, origins } = deps.config;
  const result = await verify(() => deps.webauthn.verifyRegistrationResponse({
    response,
    expectedChallenge: (c) => consume(deps, c, "register", uid),
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: false, // Android doesn't ask the user for restore keys
  }));
  if (!result.verified) throw new HttpError(400, "Restore key not verified.");

  const { credential } = result.registrationInfo;
  const now = deps.now();
  await deps.store.saveKey(credential.id, {
    uid,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    createdAt: now,
    lastUsedAt: now,
  });

  const keys = (await deps.store.listKeys(uid)).sort((a, b) => a.createdAt - b.createdAt);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_KEYS_PER_USER))) {
    await deps.store.deleteKey(old.id);
  }
  return { saved: true };
}

async function signInOptions(deps) {
  const options = await deps.webauthn.generateAuthenticationOptions({
    rpID: deps.config.rpID,
    userVerification: "discouraged",
    allowCredentials: [], // the key itself says whose it is
  });
  await deps.store.createChallenge(options.challenge, { type: "signin", expiresAt: deps.now() + CHALLENGE_TTL_MS });
  return options;
}

async function signIn({ response }, deps) {
  const id = response && response.id;
  const key = id ? await deps.store.getKey(id) : null;
  if (!key) throw new HttpError(404, "Unknown restore key.");

  const { rpID, origins } = deps.config;
  const result = await verify(() => deps.webauthn.verifyAuthenticationResponse({
    response,
    expectedChallenge: (c) => consume(deps, c, "signin"),
    expectedOrigin: origins,
    expectedRPID: rpID,
    credential: { id, publicKey: isoBase64URL.toBuffer(key.publicKey), counter: key.counter },
    requireUserVerification: false,
  }));
  if (!result.verified) throw new HttpError(400, "Restore key not verified.");

  let user;
  try {
    user = await deps.auth.getUser(key.uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    await deps.store.deleteKey(id); // the account was deleted
    throw new HttpError(404, "Account no longer exists.");
  }
  if (user.disabled) throw new HttpError(403, "Account is disabled.");

  await deps.store.updateKey(id, { counter: result.authenticationInfo.newCounter, lastUsedAt: deps.now() });
  return { token: await deps.auth.createCustomToken(key.uid) };
}

// --- HTTP endpoints -----------------------------------------------------------------------------

function liveDeps() {
  return { store: firestoreStore(), auth: getAuth(), webauthn, config: readConfig(), now: Date.now };
}

function endpoint(requireAuth, handler) {
  // maxInstances caps what the two unauthenticated endpoints can cost if someone floods them.
  return onRequest({ maxInstances: 10 }, async (req, res) => {
    if (!await Validation.validateAll(req, res, { requireAuth })) return;
    try {
      sendApiResponse(res, 200, await handler(req, liveDeps()));
    } catch (e) {
      if (e instanceof HttpError) {
        logger.warn("restore key refused", e.message);
        sendApiResponse(res, e.status, null, e.message);
      } else {
        logger.error("restore key error", e);
        sendApiResponse(res, 500, null, "Internal Server Error.");
      }
    }
  });
}

const user = (req) => ({ uid: req.user.uid, signInProvider: req.user.firebase && req.user.firebase.sign_in_provider });
const body = (req) => (req.body && req.body.response) || null;

module.exports = {
  registerOptions: endpoint(true, (req, deps) => registerOptions(user(req), deps)),
  register: endpoint(true, (req, deps) => register({ uid: req.user.uid, response: body(req) }, deps)),
  signInOptions: endpoint(false, (req, deps) => signInOptions(deps)),
  signIn: endpoint(false, (req, deps) => signIn({ response: body(req) }, deps)),
  // for tests
  _internal: { registerOptions, register, signInOptions, signIn, readConfig, HttpError, MAX_KEYS_PER_USER, CHALLENGE_TTL_MS },
};
