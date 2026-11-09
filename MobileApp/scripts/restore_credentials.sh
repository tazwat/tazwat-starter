#!/usr/bin/env bash
# Restore Credentials (Google Play Zero-Tap Sign-In) helper. Guide: skills/enable-restore-credentials/SKILL.md
#
#   scripts/restore_credentials.sh origin [--sha256 AA:BB:…]… [--keystore FILE [--alias A] [--storepass P]]
#       Prints RESTORE_ANDROID_ORIGINS for Web/functions/.env: one android:apk-key-hash:… per signing cert.
#       --sha256: a SHA-256 fingerprint as Play Console shows it (Test and release › App integrity ›
#       App signing: the app signing key AND the upload key). Repeatable. No option = the debug keystore.
#
#   scripts/restore_credentials.sh check
#       Checks the app's wiring (flags, manifest, functions config) and, when CLOUD_FUNCTIONS_URL is set,
#       that restoreKeySignInOptions is deployed and answers. Read-only. Exit 1 when something is missing.
#
# Run from MobileApp/.
set -euo pipefail
cd "$(dirname "$0")/.."

to_origin() { # "AA:BB:…" -> android:apk-key-hash:<base64url, no padding>
  local hex
  hex=$(printf '%s' "$1" | tr -d ': \n' | tr 'a-f' 'A-F')
  [[ "$hex" =~ ^[0-9A-F]{64}$ ]] || { echo "Not a SHA-256 fingerprint: $1" >&2; exit 2; }
  printf 'android:apk-key-hash:%s' "$(perl -e 'print pack("H*", shift)' "$hex" | base64 | tr '+/' '-_' | tr -d '=\n')"
}

keystore_sha256() { # file alias storepass
  keytool -list -v -keystore "$1" -alias "$2" -storepass "$3" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1
}

cmd_origin() {
  local shas=() keystore="" alias="" storepass=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --sha256) shas+=("$2"); shift 2 ;;
      --keystore) keystore="$2"; shift 2 ;;
      --alias) alias="$2"; shift 2 ;;
      --storepass) storepass="$2"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
  done
  if [[ -n "$keystore" ]]; then
    [[ -n "$alias" && -n "$storepass" ]] || { echo "--keystore needs --alias and --storepass" >&2; exit 2; }
    shas+=("$(keystore_sha256 "$keystore" "$alias" "$storepass")")
  fi
  if [[ ${#shas[@]} -eq 0 ]]; then
    local debug="$HOME/.android/debug.keystore"
    [[ -f "$debug" ]] || { echo "No --sha256/--keystore given and no $debug" >&2; exit 2; }
    echo "# debug keystore only — add the Play app signing key for release builds" >&2
    shas+=("$(keystore_sha256 "$debug" androiddebugkey android)")
  fi
  local out=() s
  for s in "${shas[@]}"; do out+=("$(to_origin "$s")"); done
  (IFS=,; echo "RESTORE_ANDROID_ORIGINS=${out[*]}")
}

cmd_check() {
  local fail=0 cfg=shared/src/commonMain/kotlin/com/*/*/root/AppConfiguration.kt
  local manifest=androidApp/src/main/AndroidManifest.xml env=../Web/functions/.env
  ok() { echo "✅ $1"; }
  bad() { echo "❌ $1"; fail=1; }
  warn() { echo "⚠️  $1"; }

  # shellcheck disable=SC2086
  local appconfig; appconfig=$(cat $cfg 2>/dev/null || true)
  [[ -n "$appconfig" ]] || { bad "AppConfiguration.kt not found"; exit 1; }
  grep -q 'AUTH_SOCIAL_LOGIN_ENABLED = true' <<<"$appconfig" && ok "social sign-in on" || bad "AUTH_SOCIAL_LOGIN_ENABLED is not true (restore keys only cover Google/Apple users)"
  grep -q 'RESTORE_CREDENTIALS_ENABLED' <<<"$appconfig" || bad "RESTORE_CREDENTIALS_ENABLED missing from AppConfiguration.kt (sync the template)"
  grep -q 'RESTORE_CREDENTIALS_ENABLED = false' <<<"$appconfig" && bad "RESTORE_CREDENTIALS_ENABLED = false"
  local url; url=$(sed -n 's/.*const val CLOUD_FUNCTIONS_URL = "\(.*\)".*/\1/p' <<<"$appconfig")
  [[ -n "$url" ]] && ok "CLOUD_FUNCTIONS_URL = $url" || bad "CLOUD_FUNCTIONS_URL is blank"
  ls shared/src/androidMain/kotlin/com/*/*/data/source/auth/RestoreCredentialsImpl.kt >/dev/null 2>&1 \
    && ok "RestoreCredentialsImpl present" || bad "RestoreCredentialsImpl.kt missing (sync the template)"

  if grep -q 'android:allowBackup="false"' "$manifest"; then
    ok "allowBackup=false: no backup agent needed (first-launch restore still works)"
  elif grep -q 'android:backupAgent=' "$manifest"; then
    grep -q 'RestoreBackupAgent' "$manifest" && ok "RestoreBackupAgent declared" \
      || warn "app has its own backupAgent: make sure its onRestoreFinished() calls RestoreCredentialsImpl(this).restore()"
  else
    bad "no android:backupAgent in the manifest (see the skill, step 3)"
  fi

  if [[ -f "$env" ]]; then
    grep -q '^RESTORE_RP_ID=..*' "$env" && ok "functions .env: RESTORE_RP_ID set" || bad "functions .env: RESTORE_RP_ID not set"
    grep -q '^RESTORE_ANDROID_ORIGINS=android:apk-key-hash:' "$env" && ok "functions .env: RESTORE_ANDROID_ORIGINS set" \
      || bad "functions .env: RESTORE_ANDROID_ORIGINS not set (scripts/restore_credentials.sh origin)"
  else
    bad "no Web/functions/.env (copy .env.example and set RESTORE_RP_ID / RESTORE_ANDROID_ORIGINS)"
  fi

  if [[ -n "$url" ]]; then
    local answer
    answer=$(curl -s -m 20 -X POST -H 'Content-Type: application/json' -d '{}' "$url/restoreKeySignInOptions" || true)
    grep -q '"challenge"' <<<"$answer" && ok "restoreKeySignInOptions deployed and answering" \
      || bad "restoreKeySignInOptions didn't answer with a challenge (deploy functions with RESTORE_RP_ID set): ${answer:0:160}"
  fi
  return $fail
}

case "${1:-}" in
  origin) shift; cmd_origin "$@" ;;
  check) cmd_check ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
