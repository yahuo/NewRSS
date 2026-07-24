const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');

const {
  BACKUP_FILE_PATTERN,
  BACKUP_LOCK_DATABASE_FILE,
  DEFAULT_RETENTION_COUNT,
  runBackup,
} = require('../scripts/backup-database');

test('online backup is valid and keeps the seven most recent successful backups', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-');
  const previousBackupNames = Array.from(
    { length: DEFAULT_RETENTION_COUNT },
    (_, index) => `newrss-202607${String(15 + index).padStart(2, '0')}T033000Z.sqlite`
  );
  const unrelatedFile = path.join(fixture.outputDirectory, 'keep.txt');

  for (const name of previousBackupNames) {
    fs.writeFileSync(path.join(fixture.outputDirectory, name), 'previous');
  }
  fs.writeFileSync(unrelatedFile, 'keep');

  const result = await runBackup({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: fixture.outputDirectory,
    now: new Date('2026-07-22T03:30:00.000Z'),
  });

  assert.equal(path.basename(result.path), 'newrss-20260722T033000Z.sqlite');
  assert.equal(result.retentionCount, DEFAULT_RETENTION_COUNT);
  assert.match(result.runId, /^[a-f0-9]{32}$/);
  assert.deepEqual(result.removedBackups, ['newrss-20260715T033000Z.sqlite']);
  assert.equal(fs.existsSync(path.join(fixture.outputDirectory, previousBackupNames[0])), false);
  assert.equal(fs.existsSync(path.join(fixture.outputDirectory, previousBackupNames.at(-1))), true);
  assert.equal(fs.readFileSync(unrelatedFile, 'utf8'), 'keep');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(listBackupFiles(fixture.outputDirectory).length, DEFAULT_RETENTION_COUNT);
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);

  const restored = new DatabaseSync(result.path, { readOnly: true });
  assert.deepEqual(restored.prepare('SELECT * FROM items ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 1, title: 'first' },
    { id: 2, title: 'second' },
  ]);
  assert.deepEqual(restored.prepare('PRAGMA integrity_check').all().map((row) => ({ ...row })), [
    { integrity_check: 'ok' },
  ]);
  restored.close();
});

test('failed backup leaves the previous successful backup untouched', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-backup-failure-'));
  const nativeDirectory = path.join(directory, 'native');
  const outputDirectory = path.join(directory, 'output');
  const previousBackup = path.join(outputDirectory, 'newrss-20260721T033000Z.sqlite');
  fs.mkdirSync(nativeDirectory);
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(previousBackup, 'previous');

  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    runBackup({
      dbPath: path.join(nativeDirectory, 'missing.db'),
      nativeTempDir: nativeDirectory,
      outputDir: outputDirectory,
      now: new Date('2026-07-22T03:30:00.000Z'),
    }),
    /unable to open database file/
  );

  assert.equal(fs.readFileSync(previousBackup, 'utf8'), 'previous');
  assert.deepEqual(listBackupFiles(outputDirectory), ['newrss-20260721T033000Z.sqlite']);
  assert.deepEqual(listTransientBackupArtifacts(outputDirectory), []);
  assertLockDatabaseIdle(outputDirectory);
});

test('cross-process concurrent backup cannot delete the successful backup', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-concurrent-');
  let releaseFirstBackup;
  let markFirstBackupStarted;
  const firstBackupStarted = new Promise((resolve) => {
    markFirstBackupStarted = resolve;
  });
  const firstBackupMayContinue = new Promise((resolve) => {
    releaseFirstBackup = resolve;
  });
  const firstBackup = runBackup({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: fixture.outputDirectory,
    now: new Date('2026-07-22T03:30:00.000Z'),
    async backupDatabase(sourceDb, destinationPath) {
      markFirstBackupStarted();
      await firstBackupMayContinue;
      return backup(sourceDb, destinationPath);
    },
  });

  await firstBackupStarted;
  let competingResult;
  try {
    competingResult = await runBackupInChild({
      dbPath: fixture.dbPath,
      nativeTempDir: fixture.nativeDirectory,
      outputDir: fixture.outputDirectory,
      now: '2026-07-22T03:30:01.000Z',
    });
  } finally {
    releaseFirstBackup();
  }

  const firstResult = await firstBackup;
  assert.notEqual(competingResult.code, 0);
  assert.match(competingResult.stderr, /BACKUP_IN_PROGRESS:backup already running/);
  assert.equal(fs.existsSync(firstResult.path), true);

  const backupFiles = listBackupFiles(fixture.outputDirectory);
  assert.ok(backupFiles.length >= 1);
  for (const name of backupFiles) {
    assertDatabaseQuickCheck(path.join(fixture.outputDirectory, name));
  }
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);
});

test('stale lock and temporary files are removed before the next backup', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-stale-');
  const staleNative = path.join(
    fixture.nativeDirectory,
    '.newrss-backup-20260720T033000Z-12345.sqlite'
  );
  const staleNativeWal = `${staleNative}-wal`;
  const staleOutput = path.join(fixture.outputDirectory, '.newrss-20260720T033000Z-12345.tmp');
  const staleLock = path.join(fixture.outputDirectory, '.newrss-backup.lock');
  const stalePaths = [staleNative, staleNativeWal, staleOutput, staleLock];

  fs.writeFileSync(staleNative, 'stale');
  fs.writeFileSync(staleNativeWal, 'stale');
  fs.writeFileSync(staleOutput, 'stale');
  fs.writeFileSync(staleLock, JSON.stringify({ runId: 'stale', pid: 99_999_999 }));
  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  for (const filePath of stalePaths) {
    fs.utimesSync(filePath, staleTime, staleTime);
  }

  const result = await runBackup({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: fixture.outputDirectory,
    now: new Date('2026-07-22T03:30:00.000Z'),
  });

  for (const filePath of stalePaths) {
    assert.equal(fs.existsSync(filePath), false);
  }
  assert.deepEqual(result.removedStaleArtifacts, stalePaths.sort());
  assertDatabaseQuickCheck(result.path);
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assert.deepEqual(listTransientBackupArtifacts(fixture.nativeDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);
});

test('abrupt process exit releases the coordinator lock for the next backup', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-crash-lock-');
  const markerPath = path.join(fixture.directory, 'lock-held');
  const child = startHoldingBackupChild({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: fixture.outputDirectory,
    markerPath,
  });
  t.after(() => {
    if (child.exitCode == null) {
      child.kill('SIGKILL');
    }
  });

  await waitForFile(markerPath);
  const childClosed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGKILL');
  await childClosed;

  const result = await runBackup({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: fixture.outputDirectory,
    now: new Date('2026-07-22T03:30:01.000Z'),
  });

  assertDatabaseQuickCheck(result.path);
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assert.deepEqual(listTransientBackupArtifacts(fixture.nativeDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);
});

test('insufficient free space fails before native backup generation', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-space-');
  const previousBackup = path.join(fixture.outputDirectory, 'newrss-20260721T033000Z.sqlite');
  let backupCalls = 0;
  fs.writeFileSync(previousBackup, 'previous');

  await assert.rejects(
    runBackup({
      dbPath: fixture.dbPath,
      nativeTempDir: fixture.nativeDirectory,
      outputDir: fixture.outputDirectory,
      now: new Date('2026-07-22T03:30:00.000Z'),
      statfsSyncFn() {
        return { bavail: 0n, bsize: 4096n };
      },
      async backupDatabase() {
        backupCalls += 1;
      },
    }),
    /insufficient free space/
  );

  assert.equal(backupCalls, 0);
  assert.equal(fs.readFileSync(previousBackup, 'utf8'), 'previous');
  assert.deepEqual(listBackupFiles(fixture.outputDirectory), ['newrss-20260721T033000Z.sqlite']);
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);
});

test('clock regression does not replace newer retained backups', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-clock-');
  const futureBackup = path.join(fixture.outputDirectory, 'newrss-20260723T033000Z.sqlite');
  fs.writeFileSync(futureBackup, 'future');

  await assert.rejects(
    runBackup({
      dbPath: fixture.dbPath,
      nativeTempDir: fixture.nativeDirectory,
      outputDir: fixture.outputDirectory,
      now: new Date('2026-07-22T03:30:00.000Z'),
    }),
    (error) => error.code === 'BACKUP_CLOCK_REGRESSION'
  );

  assert.equal(fs.readFileSync(futureBackup, 'utf8'), 'future');
  assert.deepEqual(listBackupFiles(fixture.outputDirectory), ['newrss-20260723T033000Z.sqlite']);
  assert.deepEqual(listTransientBackupArtifacts(fixture.outputDirectory), []);
  assertLockDatabaseIdle(fixture.outputDirectory);
});

test('cleanup failures preserve the primary error and do not skip later cleanup steps', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-cleanup-');
  const originalUnlinkSync = fs.unlinkSync;
  let nativeTempPath = '';
  let outputCleanupAttempted = false;
  let caughtError;

  fs.unlinkSync = (filePath) => {
    if (filePath === nativeTempPath) {
      const error = new Error('native cleanup failure');
      error.code = 'EACCES';
      throw error;
    }
    if (path.dirname(filePath) === fixture.outputDirectory && filePath.endsWith('.tmp')) {
      outputCleanupAttempted = true;
    }
    return originalUnlinkSync(filePath);
  };

  try {
    await runBackup({
      dbPath: fixture.dbPath,
      nativeTempDir: fixture.nativeDirectory,
      outputDir: fixture.outputDirectory,
      now: new Date('2026-07-22T03:30:00.000Z'),
      async backupDatabase(_sourceDb, destinationPath) {
        nativeTempPath = destinationPath;
        fs.writeFileSync(destinationPath, 'partial');
        throw new Error('primary backup failure');
      },
    });
  } catch (error) {
    caughtError = error;
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.ok(caughtError);
  assert.match(caughtError.message, /^primary backup failure; cleanup failed:/);
  assert.equal(caughtError.cleanupErrors.length, 1);
  assert.equal(outputCleanupAttempted, true);
  assertLockDatabaseIdle(fixture.outputDirectory);
  originalUnlinkSync(nativeTempPath);
});

test('physical directory aliases share one coordinator lock', async (t) => {
  const fixture = createDatabaseFixture(t, 'newrss-backup-alias-');
  const outputAlias = path.join(fixture.directory, 'native-alias');
  fs.symlinkSync(fixture.nativeDirectory, outputAlias, 'dir');

  const result = await runBackup({
    dbPath: fixture.dbPath,
    nativeTempDir: fixture.nativeDirectory,
    outputDir: outputAlias,
    now: new Date('2026-07-22T03:30:00.000Z'),
  });

  assertDatabaseQuickCheck(result.path);
  assertLockDatabaseIdle(fixture.nativeDirectory);
});

function createDatabaseFixture(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nativeDirectory = path.join(directory, 'native');
  const outputDirectory = path.join(directory, 'output');
  const dbPath = path.join(nativeDirectory, 'newrss.db');
  fs.mkdirSync(nativeDirectory);
  fs.mkdirSync(outputDirectory);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);');
  db.prepare('INSERT INTO items (title) VALUES (?)').run('first');
  db.prepare('INSERT INTO items (title) VALUES (?)').run('second');

  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    directory,
    nativeDirectory,
    outputDirectory,
    dbPath,
  };
}

function runBackupInChild({ dbPath, nativeTempDir, outputDir, now }) {
  const modulePath = path.resolve(__dirname, '../scripts/backup-database.js');
  const childScript = `
    const { runBackup } = require(process.env.TEST_BACKUP_MODULE);
    runBackup({
      dbPath: process.env.TEST_DB_PATH,
      nativeTempDir: process.env.TEST_NATIVE_TEMP_DIR,
      outputDir: process.env.TEST_OUTPUT_DIR,
      now: new Date(process.env.TEST_NOW),
    }).then(() => {
      process.stdout.write('ok');
    }).catch((error) => {
      process.stderr.write(String(error.code || 'ERROR') + ':' + error.message);
      process.exitCode = 2;
    });
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', childScript], {
      env: {
        ...process.env,
        TEST_BACKUP_MODULE: modulePath,
        TEST_DB_PATH: dbPath,
        TEST_NATIVE_TEMP_DIR: nativeTempDir,
        TEST_OUTPUT_DIR: outputDir,
        TEST_NOW: now,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for competing backup process'));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function startHoldingBackupChild({ dbPath, nativeTempDir, outputDir, markerPath }) {
  const modulePath = path.resolve(__dirname, '../scripts/backup-database.js');
  const childScript = `
    const fs = require('node:fs');
    const { runBackup } = require(process.env.TEST_BACKUP_MODULE);
    runBackup({
      dbPath: process.env.TEST_DB_PATH,
      nativeTempDir: process.env.TEST_NATIVE_TEMP_DIR,
      outputDir: process.env.TEST_OUTPUT_DIR,
      now: new Date('2026-07-22T03:30:00.000Z'),
      backupDatabase() {
        fs.writeFileSync(process.env.TEST_MARKER_PATH, 'held');
        return new Promise(() => setInterval(() => {}, 1000));
      },
    }).catch((error) => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 2;
    });
  `;

  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', childScript], {
    env: {
      ...process.env,
      TEST_BACKUP_MODULE: modulePath,
      TEST_DB_PATH: dbPath,
      TEST_NATIVE_TEMP_DIR: nativeTempDir,
      TEST_OUTPUT_DIR: outputDir,
      TEST_MARKER_PATH: markerPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listBackupFiles(outputDirectory) {
  return fs.readdirSync(outputDirectory).filter((name) => BACKUP_FILE_PATTERN.test(name)).sort();
}

function listTransientBackupArtifacts(outputDirectory) {
  return fs
    .readdirSync(outputDirectory)
    .filter((name) => name.startsWith('.newrss-') && name !== BACKUP_LOCK_DATABASE_FILE)
    .sort();
}

function assertLockDatabaseIdle(directory) {
  const lockDb = new DatabaseSync(path.join(directory, BACKUP_LOCK_DATABASE_FILE), { readOnly: true });
  try {
    assert.equal(lockDb.prepare('SELECT COUNT(*) AS count FROM backup_lock_owner').get().count, 0);
  } finally {
    lockDb.close();
  }
}

function assertDatabaseQuickCheck(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA quick_check').all().map((row) => ({ ...row })), [
      { quick_check: 'ok' },
    ]);
  } finally {
    db.close();
  }
}
