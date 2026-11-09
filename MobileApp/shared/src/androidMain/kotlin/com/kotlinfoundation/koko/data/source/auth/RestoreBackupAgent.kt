package com.kotlinfoundation.koko.data.source.auth

import android.app.backup.BackupAgent
import android.app.backup.BackupDataInput
import android.app.backup.BackupDataOutput
import android.os.ParcelFileDescriptor
import com.google.firebase.FirebaseApp
import kotlinx.coroutines.runBlocking

/**
 * Signs the user back in right after Android restores the app on a new phone, before they open it
 * (the first-launch check in UserRepository is the fallback). Declared in androidApp's manifest with
 * `android:fullBackupOnly="true"`, so Android keeps its automatic full backup and never calls the
 * key/value hooks below.
 */
class RestoreBackupAgent : BackupAgent() {

    override fun onBackup(oldState: ParcelFileDescriptor?, data: BackupDataOutput?, newState: ParcelFileDescriptor?) = Unit

    override fun onRestore(data: BackupDataInput?, appVersionCode: Int, newState: ParcelFileDescriptor?) = Unit

    override fun onRestoreFinished() {
        // Restore runs the app in a restricted mode: no Application.onCreate, so no Koin and no automatic
        // Firebase start. The call must finish before this method returns, hence runBlocking.
        FirebaseApp.initializeApp(this)
        runBlocking { RestoreCredentialsImpl(this@RestoreBackupAgent).restore() }
        // If your backend keeps FCM tokens, send this device's token here so notifications resume
        // before the first launch (the template only logs tokens: AppInitializer.initializeNotification).
    }
}
