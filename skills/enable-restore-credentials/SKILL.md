---
name: enable-restore-credentials
description: Turn on Google Play "Zero-Tap Sign-In" (Android Restore Credentials API) — users who signed in with Google/Apple are signed back in automatically on a new Android phone. Required by Google Play from April 2027 for every non-game app with sign-in. Covers the restore-key Cloud Functions, Firestore, the signing-key origins, IAM, the backup agent, validation, and bringing older apps built from this template up to date. Use when the developer mentions Restore Credentials, Zero-Tap Sign-In, device migration sign-in, or a Play Console warning about it.
---

# Enable Restore Credentials (Zero-Tap Sign-In)

**Why:** from **April 2027**, Google Play requires apps that support sign-in (optional or mandatory) to
restore the user's sign-in on a new Android device with the **Restore Credentials API**. Apps that don't
lose full publishing capabilities and Play visibility. Games are exempt for now.
Source: [Android Developers Blog, Aug 2026](https://android-developers.googleblog.com/2026/08/app-quality-memory-optimization-secure-onboarding.html),
[Play help](https://support.google.com/googleplay/android-developer/answer/17492799#zero-tap_sign-in_restoration),
[API guide](https://developer.android.com/identity/sign-in/restore-credentials).

**Who needs it:** apps with `AUTH_SOCIAL_LOGIN_ENABLED = true`. Guest-only apps (anonymous auth) have
nothing to restore and skip this skill. Android only; iOS is untouched.

## How it works (already in the template)

1. After a Google/Apple sign-in, the app creates a hidden **restore key** (a WebAuthn key, like a passkey
   the user never sees). Google backs it up with the phone.
2. On a new phone, before making a guest account, the app asks Android for that key and sends it to the
   `restoreKeySignIn` Cloud Function, which checks it and returns a **Firebase custom token**. The app
   signs in with it: the user is back without a tap.
3. Sign-out and account deletion delete the key on the phone.

| Piece | File |
|---|---|
| Shared interface (no-op off Android) | `MobileApp/shared/src/commonMain/.../data/source/auth/RestoreCredentials.kt` |
| Android implementation | `MobileApp/shared/src/androidMain/.../data/source/auth/RestoreCredentialsImpl.kt` |
| Background restore (runs when Android restores the app, before first launch) | `.../data/source/auth/RestoreBackupAgent.kt` + `android:backupAgent` / `android:fullBackupOnly` in `androidApp/src/main/AndroidManifest.xml` |
| Calls: first launch (before guest sign-in), after sign-in, at startup for existing users, on logout | `UserRepository` (`signInAnonymouslyIfNecessary`, `onSuccessfulOauthSign`, `logOut`) |
| Flag | `AppConfiguration.RESTORE_CREDENTIALS_ENABLED` (defaults to `AUTH_SOCIAL_LOGIN_ENABLED`) |
| Server: 4 HTTP functions + tests | `Web/functions/api/restoreKeys.js`, `Web/functions/test/restoreKeys.test.js` |
| Helper | `MobileApp/scripts/restore_credentials.sh` (`origin`, `check`) |

The functions are `restoreKeyRegisterOptions`, `restoreKeyRegister` (both need the Firebase ID token),
`restoreKeySignInOptions`, `restoreKeySignIn` (no token: the phone isn't signed in yet). They store keys in
Firestore `restoreKeys/{keyId}` and one-time challenges in `restoreChallenges/{id}` (5-minute expiry).
At most 5 keys per user (oldest dropped); a key unused for a year, or whose account was deleted, is refused
and removed.

## 0. Older app built from the template — Agent Action

Skip if the app already has `RestoreCredentialsImpl.kt`.

1. Pull the template with the `sync-template` skill. The files above arrive with the merge.
2. If the app changed `UserRepository`, `Di.kt`, `Platform.android.kt`, `AppConfiguration.kt` or the
   manifest, resolve the conflicts so that:
   - `UserRepository` takes `restoreCredentials: RestoreCredentials = RestoreCredentials.None` and
     - in `signInAnonymouslyIfNecessary`, when there's no user on a first launch, calls
       `restoreCredentials.restore()` **before** `signInAnonymously()` (skip the guest when it returns true),
       and otherwise calls `restoreCredentials.save()`;
     - calls `restoreCredentials.save()` in `onSuccessfulOauthSign()` (and after any other sign-in path
       the app added);
     - calls `restoreCredentials.clear()` in `logOut()` before `KMPAuth.signOut()`.
   - `Di.kt`: `UserRepository(…, getOrNull() ?: RestoreCredentials.None)`.
   - `Platform.android.kt`: `single<RestoreCredentials> { RestoreCredentialsImpl(androidContext()) }`.
   - `libs.versions.toml` + `shared/build.gradle.kts` androidMain: `androidx.credentials:credentials` and
     `credentials-play-services-auth` (1.5.0 or newer).
3. Manifest, by the app's backup setting (**never change `allowBackup` for this**):
   - no `allowBackup` or `allowBackup="true"`, no backup agent → add
     `android:backupAgent="<package>.data.source.auth.RestoreBackupAgent"` and `android:fullBackupOnly="true"`;
   - `allowBackup="false"` → add nothing; the first-launch restore still works;
   - the app already has its own backup agent → don't add `fullBackupOnly`; in that agent's
     `onRestoreFinished()` call `FirebaseApp.initializeApp(this)` then
     `runBlocking { RestoreCredentialsImpl(this@YourAgent).restore() }`.
4. If the app's backend keeps FCM tokens, send the token after a background restore (comment in
   `RestoreBackupAgent.onRestoreFinished`).

## 1. Firestore — User Action

The functions store keys in Firestore (the Admin SDK, so rules don't apply to them).

- Firebase console → **Firestore Database**: create the database if the app doesn't have one yet.
- **Rules**: make sure the app can't read these collections. If the rules allow broad access, add:

  ```
  match /restoreKeys/{id} { allow read, write: if false; }
  match /restoreChallenges/{id} { allow read, write: if false; }
  ```
- Optional: **TTL policy** on collection group `restoreChallenges`, field `expiresAt`, so unused challenges
  are deleted (Firestore → Time-to-live). They're refused after 5 minutes either way.

**Stop and confirm.**

## 2. Pick the domain (`RESTORE_RP_ID`) — User Action

Any domain the developer controls, e.g. the app's page on the company site (`myapp.tazwat.com`), without
`https://`. **Never change it after release**: keys made for one domain don't work with another, so every
user would lose automatic restore until they sign in again.

Google's restore-key docs ask for no Digital Asset Links file. If creating a key fails with a domain/
security error (step 6), publish `/.well-known/assetlinks.json` on that domain for the app's package
and signing certificates, as for passkeys.

## 3. Signing-key origins (`RESTORE_ANDROID_ORIGINS`) — Agent Action + User Action

The server only accepts keys from the app's own signing certificates. Each certificate becomes an
`android:apk-key-hash:<base64url SHA-256>` origin.

- **User Action** — Play Console → **Test and release › App integrity › App signing**: copy the SHA-256 of
  the **app signing key** and of the **upload key**. (Before the first Play upload, use the upload/release
  keystore and add the app signing key later.)
- **Agent Action** — from `MobileApp/`:

  ```bash
  ./scripts/restore_credentials.sh origin --sha256 <APP_SIGNING_SHA256> --sha256 <UPLOAD_SHA256>
  ./scripts/restore_credentials.sh origin            # debug keystore, for local testing
  ```
  Join the values into one comma-separated `RESTORE_ANDROID_ORIGINS` line. The values come from public
  certificates; they're not secrets.

## 4. Configure and deploy the functions — User Action

1. `Web/functions/.env` (copy `.env.example` if missing):

   ```properties
   RESTORE_RP_ID=myapp.tazwat.com
   RESTORE_ANDROID_ORIGINS=android:apk-key-hash:…,android:apk-key-hash:…
   ```
2. From `Web/`: `cd functions && npm install && npm test && cd .. && firebase deploy --only functions`.
   The four `restoreKey*` functions are only deployed while `RESTORE_RP_ID` is set.
3. **Let the functions create sign-in tokens** (once per Firebase project). Replace the project ID/number
   (Firebase console → Project settings):

   ```bash
   gcloud services enable iamcredentials.googleapis.com --project PROJECT_ID
   gcloud iam service-accounts add-iam-policy-binding \
     PROJECT_NUMBER-compute@developer.gserviceaccount.com \
     --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role="roles/iam.serviceAccountTokenCreator" --project PROJECT_ID
   ```
   Without it, `restoreKeySignIn` logs `iam.serviceAccounts.signBlob` permission denied.

**Stop and confirm.**

## 5. App settings — Agent Action

In `AppConfiguration.kt`: `AUTH_SOCIAL_LOGIN_ENABLED = true` (see `enable-auth`),
`CLOUD_FUNCTIONS_URL` = the deployed base URL (`https://REGION-PROJECT_ID.cloudfunctions.net`), and
`RESTORE_CREDENTIALS_ENABLED` left at its default.

## 6. Validate — Validation

1. From `MobileApp/`: `./scripts/restore_credentials.sh check` — every line ✅ (it also calls the deployed
   `restoreKeySignInOptions`).
2. `run-quality-gates` (spotless, tests, `assembleDebug`).
3. On a phone (Android 9+, signed in to a Google account, with a screen lock): sign in with Google →
   logcat shows `Restore key saved`, and Firestore has a new `restoreKeys` document. Log out → logcat shows
   no `Restore key clear failed`.
4. **Real migration test, before the release that ships it** — uninstalling or clearing app data deletes the
   key, so a single phone can't test the restore. Use two phones: back up the old one (Settings › Google ›
   Backup › Back up now), then set up the second one from that backup (or with "Copy apps & data").
   Open nothing: the background agent should already have signed the user in. Open the app: no sign-in
   screen. If the background restore didn't run, the first launch does it.

**Stop and confirm the migration test with the developer.**

## Troubleshooting

| Symptom (logcat `Restore key …` or function logs) | Fix |
|---|---|
| `Unexpected … origin "android:apk-key-hash:XYZ"` | That build's certificate isn't in `RESTORE_ANDROID_ORIGINS`: add the printed value, redeploy |
| `Unexpected … RP ID` | `RESTORE_RP_ID` doesn't match the domain the key was made for (was it changed?) |
| `CreateRestoreCredentialDomException` | Domain refused: see step 2 (assetlinks.json) |
| `HTTP 403 … Guest accounts` | Expected: guests don't get keys |
| `signBlob` / `Permission … denied` in `restoreKeySignIn` | Step 4.3 (IAM) |
| `HTTP 404 Unknown restore key` on a new phone | The key was never registered (sign-in happened before the functions were deployed, or registration failed): it gets created at the next start once things work |
| Nothing happens | `check` script; `RESTORE_CREDENTIALS_ENABLED` and `CLOUD_FUNCTIONS_URL`; Android 9+; Google Play services up to date |

## Backend notes (already handled by `restoreKeys.js`)

From Google's guidance, for anyone changing the server:
- Restore keys are stored apart from passkeys and never shown to users; user verification isn't required
  (Android reports `uv = false`).
- Uninstalling the app or clearing its data deletes the key on the phone without telling the server: old
  keys are capped (5 per user) and expire after a year unused.
- A key must stay valid on the server after the user signs out on the *old* phone, so the new phone can
  still use it. Signing out only deletes the key on that phone.
- A user can have several phones: one key each.
- If your backend revokes sessions (password reset, HTTP 401), also call `RestoreCredentials.clear()` on
  the phone. The template has no server sessions, so nothing does this yet.
