package com.kotlinfoundation.koko.data.source.auth

import android.content.Context
import android.os.Build
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreateRestoreCredentialRequest
import androidx.credentials.CreateRestoreCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetRestoreCredentialOption
import androidx.credentials.RestoreCredential
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.restorecredential.E2eeUnavailableException
import com.kotlinfoundation.koko.root.AppConfiguration
import com.kotlinfoundation.koko.util.logging.AppLogger
import com.mmk.kmpauth.core.KMPAuth
import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.auth.auth
import io.ktor.client.HttpClient
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.content.TextContent
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.coroutines.cancellation.CancellationException

/**
 * Android Restore Credentials (Google Play "Zero-Tap Sign-In") on top of Firebase Auth: the key is checked by
 * the `restoreKey*` Cloud Functions (`Web/functions/api/restoreKeys.js`), which answer with a Firebase custom
 * token. Used at first launch ([com.kotlinfoundation.koko.data.repository.UserRepository]) and right after
 * Android restores the app on a new phone ([RestoreBackupAgent]). Guide: skills/enable-restore-credentials.
 */
class RestoreCredentialsImpl(
    context: Context,
    private val functionsUrl: String = AppConfiguration.CLOUD_FUNCTIONS_URL,
) : RestoreCredentials {

    private val context = context.applicationContext
    private val credentialManager = CredentialManager.create(this.context)
    private val http = HttpClient() // no defaults: works in the backup agent, where Koin isn't started

    // Which user this device's key belongs to. Kept out of backups: a device-only key (no screen lock)
    // doesn't move to the new phone, so this note mustn't either, or the key would never be recreated.
    private val savedFor = File(this.context.noBackupFilesDir, "restore_key_uid")

    private val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P // Android 9+
    private val enabled = supported && AppConfiguration.RESTORE_CREDENTIALS_ENABLED && functionsUrl.isNotBlank()

    override suspend fun save() {
        if (!enabled) return
        logged("save", Unit) {
            val user = KMPAuth.currentUser() ?: return
            if (user.isAnonymous || savedFor.readUid() == user.uid) return
            val idToken = KMPAuth.currentUserIdToken(forceRefresh = false).getOrThrow()
                ?: error("No ID token for the signed-in user")
            val options = call("restoreKeyRegisterOptions", idToken = idToken).toString()
            val response = try {
                create(options, cloudBackup = true)
            } catch (e: E2eeUnavailableException) {
                create(options, cloudBackup = false) // no screen lock / backup: keep the key on this device
            }
            call("restoreKeyRegister", response = response, idToken = idToken)
            savedFor.writeText(user.uid)
            AppLogger.d("Restore key saved")
        }
    }

    override suspend fun restore(): Boolean {
        if (!enabled) return false
        return logged("restore", false) {
            val current = Firebase.auth.currentUser
            if (current != null && !current.isAnonymous) return false
            val options = call("restoreKeySignInOptions").toString()
            val credential = try {
                credentialManager.getCredential(context, GetCredentialRequest(listOf(GetRestoreCredentialOption(options)))).credential
            } catch (e: NoCredentialException) {
                return false // no key: a real first install
            }
            if (credential !is RestoreCredential) return false
            val result = try {
                call("restoreKeySignIn", response = Json.parseToJsonElement(credential.authenticationResponseJson))
            } catch (e: RestoreKeyRefused) {
                if (e.status == 404) clearKey() // the server dropped it (account deleted, expired): stop retrying
                throw e
            }
            val token = result["token"]?.jsonPrimitive?.contentOrNull ?: error("No token in the sign-in answer")
            val user = Firebase.auth.signInWithCustomToken(token).user ?: error("Custom token sign-in returned no user")
            savedFor.writeText(user.uid) // the key that came with the phone is this user's
            true
        }
    }

    override suspend fun clear() {
        if (!supported) return
        logged("clear", Unit) { clearKey() }
    }

    private suspend fun clearKey() {
        credentialManager.clearCredentialState(ClearCredentialStateRequest(ClearCredentialStateRequest.TYPE_CLEAR_RESTORE_CREDENTIAL))
        savedFor.delete()
    }

    private suspend fun create(optionsJson: String, cloudBackup: Boolean): JsonElement {
        val response = credentialManager.createCredential(context, CreateRestoreCredentialRequest(optionsJson, cloudBackup))
        return Json.parseToJsonElement((response as CreateRestoreCredentialResponse).responseJson)
    }

    /** POSTs `{ "response": … }` to a restoreKey* function and returns its `data` object. */
    private suspend fun call(function: String, response: JsonElement? = null, idToken: String? = null): JsonObject {
        val body = buildJsonObject { if (response != null) put("response", response) }
        val answer = http.post("$functionsUrl/$function") {
            if (idToken != null) bearerAuth(idToken)
            setBody(TextContent(body.toString(), ContentType.Application.Json))
        }
        val json = runCatching { Json.parseToJsonElement(answer.bodyAsText()).jsonObject }.getOrNull()
        if (!answer.status.isSuccess()) {
            throw RestoreKeyRefused(answer.status.value, json?.get("errorMessage")?.jsonPrimitive?.contentOrNull)
        }
        return json?.get("data")?.jsonObject ?: error("$function answered without data")
    }

    private fun File.readUid(): String? = if (exists()) readText() else null

    // Restore keys must never break sign-in: log and fall back (guest sign-in, no key).
    private inline fun <T> logged(what: String, fallback: T, block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AppLogger.e("Restore key $what failed: ${e.message}")
        fallback
    }
}

class RestoreKeyRefused(val status: Int, message: String?) : Exception("HTTP $status: $message")
