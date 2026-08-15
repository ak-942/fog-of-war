import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';

const BACKUP_FILENAME = 'explore_backup.json';
const DRIVE_APP_DATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export async function initGoogleDrive() {
  await GoogleAuth.initialize({
    scopes: [DRIVE_APP_DATA_SCOPE, 'email', 'profile'],
  });
}

async function getAccessToken() {
  try {
    const user = await GoogleAuth.signIn();
    return user.authentication.accessToken;
  } catch (err) {
    throw new Error('Google Sign-In failed or was cancelled.');
  }
}

async function findBackupFileId(accessToken) {
  const query = encodeURIComponent(`name = '${BACKUP_FILENAME}' and 'appDataFolder' in parents and trashed = false`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

export async function backupToDrive(payload) {
  const accessToken = await getAccessToken();
  const fileId = await findBackupFileId(accessToken);
  const jsonContent = JSON.stringify(payload, null, 2);

  if (fileId) {
    // Overwrite existing backup file
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: jsonContent,
    });
  } else {
    // Create new backup file in appDataFolder
    const metadata = { name: BACKUP_FILENAME, parents: ['appDataFolder'] };
    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('file', new Blob([jsonContent], { type: 'application/json' }));

    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });
  }

  const nowISO = new Date().toISOString();
  localStorage.setItem('explore_last_drive_backup', nowISO);
  return nowISO;
}

export async function restoreFromDrive() {
  const accessToken = await getAccessToken();
  const fileId = await findBackupFileId(accessToken);

  if (!fileId) throw new Error('No existing backup found on Google Drive.');

  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return await response.json();
}

export async function checkWeeklyAutoBackup(getPayloadCallback) {
  const lastBackupStr = localStorage.getItem('explore_last_drive_backup');
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  if (!lastBackupStr || Date.now() - new Date(lastBackupStr).getTime() > SEVEN_DAYS_MS) {
    try {
      const payload = getPayloadCallback();
      await backupToDrive(payload);
    } catch (err) {
      console.warn('Weekly auto-backup skipped or failed:', err.message);
    }
  }
}