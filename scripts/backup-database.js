const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');

const BACKUP_FILE_PATTERN = /^newrss-\d{8}T\d{6}Z\.sqlite$/;

async function runBackup({
  dbPath,
  nativeTempDir = path.dirname(dbPath),
  outputDir,
  now = new Date(),
  backupDatabase = backup,
}) {
  const timestamp = formatUtcTimestamp(now);
  const finalPath = path.join(outputDir, `newrss-${timestamp}.sqlite`);
  const nativeTempPath = path.join(nativeTempDir, `.newrss-backup-${timestamp}-${process.pid}.sqlite`);
  const outputTempPath = path.join(outputDir, `.newrss-${timestamp}-${process.pid}.tmp`);

  fs.mkdirSync(nativeTempDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

  if (fs.existsSync(finalPath)) {
    throw new Error(`backup already exists: ${finalPath}`);
  }

  let sourceDb;
  let copied = false;

  try {
    sourceDb = new DatabaseSync(dbPath, { readOnly: true });
    sourceDb.exec('PRAGMA query_only = ON');
    const pages = await backupDatabase(sourceDb, nativeTempPath);
    sourceDb.close();
    sourceDb = null;

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
    copied = true;

    const removedBackups = removePreviousBackups(outputDir, finalPath);
    const stats = fs.statSync(finalPath);

    return {
      path: finalPath,
      bytes: stats.size,
      sha256: outputSha256,
      pages,
      removedBackups,
      createdAt: now.toISOString(),
    };
  } finally {
    if (sourceDb) {
      sourceDb.close();
    }
    removeDatabaseArtifacts(nativeTempPath);
    if (!copied) {
      removeFileIfExists(outputTempPath);
    }
  }
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

function removePreviousBackups(outputDir, currentBackupPath) {
  const currentBackupName = path.basename(currentBackupPath);
  const removedBackups = [];

  for (const name of fs.readdirSync(outputDir)) {
    if (name === currentBackupName || !BACKUP_FILE_PATTERN.test(name)) {
      continue;
    }

    fs.unlinkSync(path.join(outputDir, name));
    removedBackups.push(name);
  }

  return removedBackups.sort();
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

function removeDatabaseArtifacts(dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    removeFileIfExists(`${dbPath}${suffix}`);
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
  const result = await runBackup({ dbPath, outputDir });
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
  removePreviousBackups,
  runBackup,
  verifyDatabase,
};
