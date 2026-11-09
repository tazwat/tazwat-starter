package com.kotlinfoundation.koko.data.source.auth

/**
 * Google Play "Zero-Tap Sign-In" (required from April 2027): a hidden restore key that signs a Google/Apple
 * user back in automatically on a new Android phone. Android implementation: `RestoreCredentialsImpl`
 * (androidMain, server half in `Web/functions/api/restoreKeys.js`); other platforms use [None].
 * Guide: skills/enable-restore-credentials/SKILL.md.
 *
 * None of these functions throw: a failure is logged and the app carries on as before.
 */
interface RestoreCredentials {
    /** Creates the restore key for the signed-in, non-guest user (once per user and device). */
    suspend fun save()

    /**
     * Signs in with the restore key that came with this phone, replacing a guest account. Checks once per
     * phone (again after a network error); returns false at once when a non-guest user is signed in.
     * True when a user got signed in.
     */
    suspend fun restore(): Boolean

    /** Deletes this device's restore key: call on sign-out and account deletion. */
    suspend fun clear()

    object None : RestoreCredentials {
        override suspend fun save() = Unit
        override suspend fun restore() = false
        override suspend fun clear() = Unit
    }
}
