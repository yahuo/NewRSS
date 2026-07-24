const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');

const BACKUP_FILE_PATTERN = /^newrss-\d{8}T\d{6}Z\.sqlite$/;
const NATIVE_TEMP_FILE_PATTERN = /^\.newrss-backup-\d{8}T\d{6}Z-(?:[a-f0-9]{32}|\d+)\.sqlite(?:-(?:wal|shm|journal))?$/;
const OUTPUT_TEMP_FILE_PATTERN = /^\.newrss-\d{8}T\d{6}Z-(?:[a-f0-9]{32}|\d+)\.tmp$/;
const BACKUP_LOCK_DATABASE_FILE = '.newrss-backup-lock.sqlite';
const LEGACY_BACKUP_LOCK_FILE = '.newrss-backup.lock';
const DEFAULT_RETENTION_COUNT = 7;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MIN_FREE_SPACE_MARGIN_BYTES = 16n * 1024n * 1024n;

async function runBackup({
  dbPath,
  nativeTempDir = path.dirname(dbPath),
  outputDir,
  now = new Date(),
  retentionCount = DEFAULT_RETENTION_COUNT,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  backupDatabase = backup,
  statfsSyncFn = fs.statfsSync,
}) {
  const normalizedRetentionCount = normalizePositiveInteger(retentionCount, 'retentionCount');
  const timestamp = formatUtcTimestamp(now);
  const runId = crypto.randomUUID().replace(/-/g, '');
  const finalPath = path.join(outputDir, `newrss-${timestamp}.sqlite`);
  const nativeTempPath = path.join(nativeTempDir, `.newrss-backup-${timestamp}-${runId}.sqlite`);
  const outputTempPath = path.join(outputDir, `.newrss-${timestamp}-${runId}.tmp`);

  fs.mkdirSync(nativeTempDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  const locks = acquireBackupLocks([nativeTempDir, outputDir], runId);
  let sourceDb;
  let published = false;
  let result;
  let primaryError;

  try {
    const removedStaleArtifacts = cleanupStaleBackupArtifacts(nativeTempDir, outputDir, staleAfterMs);
    const removedLegacyLock = removeLegacyStaleBackupLock(outputDir, staleAfterMs);
    if (removedLegacyLock) {
      removedStaleArtifacts.push(removedLegacyLock);
      removedStaleArtifacts.sort();
    }

    if (fs.existsSync(finalPath)) {
      throw new Error(`backup already exists: ${finalPath}`);
    }
    assertBackupTimestampIsNewest(outputDir, path.basename(finalPath));

    sourceDb = new DatabaseSync(dbPath, { readOnly: true });
    sourceDb.exec('PRAGMA query_only = ON');
    const estimatedBytes = estimateDatabaseBytes(sourceDb, dbPath);
    ensureBackupSpace({
      nativeTempDir,
      outputDir,
      estimatedBytes,
      statfsSyncFn,
    });

    const pages = await backupDatabase(sourceDb, nativeTempPath);
    sourceDb.close();
    sourceDb = null;

    ensureOutputCopySpace(outputDir, nativeTempPath, statfsSyncFn);
    verifyDatabase(nativeTempPath);
    fs.copyFileSync(nativeTempPath, outputTempPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(outputTempPath, 0o600);
    fsyncFile(outputTempPath);

    const sourceSha256 = sha256File(nativeTempPath);
    const outputSha256 = sha256File(outputTempPath);
    if (sourceSha256 !== outputSha256) {
      throw new Error('copied backup checksum mismatch');
    }

    fs.renameSync(outputTempPath, finalPath);
    published = true;
    fsyncDirectory(outputDir);

    const removedBackups = removePreviousBackups(outputDir, finalPath, normalizedRetentionCount);
    if (removedBackups.length > 0) {
      fsyncDirectory(outputDir);
    }
    const stats = fs.statSync(finalPath);

    result = {
      path: finalPath,
      bytes: stats.size,
      sha256: outputSha256,
      pages,
      runId,
      retentionCount: normalizedRetentionCount,
      removedBackups,
      removedStaleArtifacts,
      createdAt: now.toISOString(),
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  attemptCleanup(cleanupErrors, () => {
    if (sourceDb) {
      sourceDb.close();
      sourceDb = null;
    }
  });
  attemptCleanup(cleanupErrors, () => removeDatabaseArtifacts(nativeTempPath));
  attemptCleanup(cleanupErrors, () => {
    if (!published) {
      removeFileIfExists(outputTempPath);
    }
  });
  attemptCleanup(cleanupErrors, () => releaseBackupLocks(locks));

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      primaryError.cleanupErrors = cleanupErrors;
      primaryError.message += `; cleanup failed: ${cleanupErrors.map((error) => error.message).join(' | ')}`;
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'backup cleanup failed');
  }

  return result;
}

function verifyDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    db.exec('PRAGMA query_only = ON');
    const integrity = db.prepare('PRAGMA integrity_check(100)').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`backup integrity check failed: ${JSON.stringify(integrity)}`);
    }

    const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`backup foreign key check failed: ${JSON.stringify(foreignKeyViolations)}`);
    }
  } finally {
    db.close();
  }
}

function removePreviousBackups(outputDir, currentBackupPath, retentionCount = DEFAULT_RETENTION_COUNT) {
  const normalizedRetentionCount = normalizePositiveInteger(retentionCount, 'retentionCount');
  const currentBackupName = path.basename(currentBackupPath);
  const backupNames = fs
    .readdirSync(outputDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .reverse();
  if (!backupNames.includes(currentBackupName)) {
    throw new Error(`current backup is missing before retention: ${currentBackupPath}`);
  }
  const removedBackups = [];

  for (const name of backupNames.slice(normalizedRetentionCount)) {
    fs.unlinkSync(path.join(outputDir, name));
    removedBackups.push(name);
  }

  return removedBackups.sort();
}

function assertBackupTimestampIsNewest(outputDir, currentBackupName) {
  const latestBackupName = fs
    .readdirSync(outputDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort()
    .at(-1);
  if (!latestBackupName || currentBackupName > latestBackupName) {
    return;
  }

  const error = new Error(
    `backup timestamp ${currentBackupName} is not newer than existing backup ${latestBackupName}`
  );
  error.code = 'BACKUP_CLOCK_REGRESSION';
  throw error;
}

function acquireBackupLocks(directories, runId) {
  const lockPaths = Array.from(
    new Set(
      directories.map((directory) =>
        path.join(fs.realpathSync.native(directory), BACKUP_LOCK_DATABASE_FILE)
      )
    )
  ).sort();
  const locks = [];

  try {
    for (const lockPath of lockPaths) {
      locks.push(acquireBackupLock(lockPath, runId));
    }
    return locks;
  } catch (error) {
    const releaseErrors = [];
    for (const lock of locks.reverse()) {
      attemptCleanup(releaseErrors, () => releaseBackupLock(lock));
    }
    if (releaseErrors.length > 0) {
      error.cleanupErrors = releaseErrors;
      error.message += `; lock cleanup failed: ${releaseErrors.map((entry) => entry.message).join(' | ')}`;
    }
    throw error;
  }
}

function acquireBackupLock(lockPath, runId) {
  let lockDb;
  try {
    lockDb = new DatabaseSync(lockPath);
    lockDb.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    lockDb.exec(`
      CREATE TABLE IF NOT EXISTS backup_lock_owner (
        run_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
      DELETE FROM backup_lock_owner;
    `);
    lockDb.prepare(`
      INSERT INTO backup_lock_owner (run_id, pid, started_at)
      VALUES (?, ?, ?)
    `).run(runId, process.pid, new Date().toISOString());
    return { db: lockDb, path: lockPath, runId };
  } catch (error) {
    let closeError;
    if (lockDb) {
      try {
        lockDb.exec('ROLLBACK');
      } catch {
        // SQLite also rolls back an open transaction when the connection closes.
      }
      try {
        lockDb.close();
      } catch (caughtCloseError) {
        closeError = caughtCloseError;
      }
    }
    if (/database is locked/i.test(String(error.message || ''))) {
      const lockError = new Error(`backup already running: ${lockPath}`);
      lockError.code = 'BACKUP_IN_PROGRESS';
      if (closeError) {
        lockError.cleanupErrors = [closeError];
        lockError.message += `; lock cleanup failed: ${closeError.message}`;
      }
      throw lockError;
    }
    if (closeError) {
      error.cleanupErrors = [closeError];
      error.message += `; lock cleanup failed: ${closeError.message}`;
    }
    throw error;
  }
}

function releaseBackupLocks(locks) {
  const errors = [];
  for (const lock of [...locks].reverse()) {
    attemptCleanup(errors, () => releaseBackupLock(lock));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'backup lock release failed');
  }
}

function releaseBackupLock(lock) {
  let primaryError;
  try {
    lock.db.prepare(`DELETE FROM backup_lock_owner WHERE run_id = ?`).run(lock.runId);
    lock.db.exec('COMMIT');
  } catch (error) {
    primaryError = error;
    try {
      lock.db.exec('ROLLBACK');
    } catch {
      // Closing the connection below is the final rollback fallback.
    }
  }

  let closeError;
  try {
    lock.db.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    primaryError.cleanupErrors = [closeError];
    primaryError.message += `; lock cleanup failed: ${closeError.message}`;
  } else if (closeError) {
    primaryError = closeError;
  }
  if (primaryError) {
    throw primaryError;
  }
}

function removeLegacyStaleBackupLock(outputDir, staleAfterMs) {
  const lockPath = path.join(outputDir, LEGACY_BACKUP_LOCK_FILE);
  let stats;
  try {
    stats = fs.statSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    owner = null;
  }
  if (
    Date.now() - stats.mtimeMs < normalizeStaleAfterMs(staleAfterMs) ||
    isProcessAlive(owner?.pid)
  ) {
    const lockError = new Error(`backup already running with legacy lock: ${lockPath}`);
    lockError.code = 'BACKUP_IN_PROGRESS';
    throw lockError;
  }

  removeFileIfExists(lockPath);
  fsyncDirectory(path.dirname(lockPath));
  return lockPath;
}

function cleanupStaleBackupArtifacts(nativeTempDir, outputDir, staleAfterMs) {
  const cutoffMs = Date.now() - normalizeStaleAfterMs(staleAfterMs);
  const removed = [
    ...removeStaleFiles(nativeTempDir, NATIVE_TEMP_FILE_PATTERN, cutoffMs),
    ...removeStaleFiles(outputDir, OUTPUT_TEMP_FILE_PATTERN, cutoffMs),
  ];

  return Array.from(new Set(removed)).sort();
}

function removeStaleFiles(directory, pattern, cutoffMs) {
  const removed = [];

  for (const name of fs.readdirSync(directory)) {
    if (!pattern.test(name)) {
      continue;
    }

    const filePath = path.join(directory, name);
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if ((!stats.isFile() && !stats.isSymbolicLink()) || stats.mtimeMs > cutoffMs) {
      continue;
    }

    fs.unlinkSync(filePath);
    removed.push(filePath);
  }

  return removed;
}

function estimateDatabaseBytes(db, dbPath) {
  const pageCount = BigInt(db.prepare('PRAGMA page_count').get().page_count);
  const pageSize = BigInt(db.prepare('PRAGMA page_size').get().page_size);
  const logicalBytes = pageCount * pageSize;
  const fileBytes = fs.statSync(dbPath, { bigint: true }).size;
  return logicalBytes > fileBytes ? logicalBytes : fileBytes;
}

function ensureBackupSpace({ nativeTempDir, outputDir, estimatedBytes, statfsSyncFn }) {
  const marginBytes = estimatedBytes / 10n > MIN_FREE_SPACE_MARGIN_BYTES
    ? estimatedBytes / 10n
    : MIN_FREE_SPACE_MARGIN_BYTES;
  const nativeDevice = fs.statSync(nativeTempDir, { bigint: true }).dev;
  const outputDevice = fs.statSync(outputDir, { bigint: true }).dev;
  const nativeAvailable = availableBytes(nativeTempDir, statfsSyncFn);
  const outputAvailable = availableBytes(outputDir, statfsSyncFn);

  if (nativeDevice === outputDevice) {
    const requiredBytes = estimatedBytes * 2n + marginBytes;
    const available = nativeAvailable < outputAvailable ? nativeAvailable : outputAvailable;
    assertAvailableSpace(nativeTempDir, requiredBytes, available);
    return;
  }

  const requiredBytes = estimatedBytes + marginBytes;
  assertAvailableSpace(nativeTempDir, requiredBytes, nativeAvailable);
  assertAvailableSpace(outputDir, requiredBytes, outputAvailable);
}

function ensureOutputCopySpace(outputDir, nativeTempPath, statfsSyncFn) {
  const backupBytes = fs.statSync(nativeTempPath, { bigint: true }).size;
  const marginBytes = backupBytes / 10n > MIN_FREE_SPACE_MARGIN_BYTES
    ? backupBytes / 10n
    : MIN_FREE_SPACE_MARGIN_BYTES;
  assertAvailableSpace(
    outputDir,
    backupBytes + marginBytes,
    availableBytes(outputDir, statfsSyncFn)
  );
}

function availableBytes(directory, statfsSyncFn) {
  const stats = statfsSyncFn(directory, { bigint: true });
  const availableBlocks = BigInt(stats.bavail);
  const blockSize = BigInt(stats.bsize);
  return availableBlocks > 0n ? availableBlocks * blockSize : 0n;
}

function assertAvailableSpace(directory, requiredBytes, available) {
  if (available >= requiredBytes) {
    return;
  }

  throw new Error(
    `insufficient free space in ${directory}: need ${requiredBytes} bytes, available ${available} bytes`
  );
}

function attemptCleanup(errors, operation) {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function normalizePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function normalizeStaleAfterMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_STALE_AFTER_MS;
}

function formatUtcTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, 'r');

  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeDatabaseArtifacts(dbPath) {
  const errors = [];
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    attemptCleanup(errors, () => removeFileIfExists(`${dbPath}${suffix}`));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'database artifact cleanup failed');
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function main() {
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'newrss.db');
  const outputDir = process.env.BACKUP_OUTPUT_DIR || path.join(process.cwd(), 'data', 'backups');
  const retentionCount = process.env.BACKUP_RETENTION_COUNT || DEFAULT_RETENTION_COUNT;
  const result = await runBackup({ dbPath, outputDir, retentionCount });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[backup] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_FILE_PATTERN,
  BACKUP_LOCK_DATABASE_FILE,
  DEFAULT_RETENTION_COUNT,
  removePreviousBackups,
  runBackup,
  verifyDatabase,
};
