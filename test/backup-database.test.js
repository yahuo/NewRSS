const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runBackup } = require('../scripts/backup-database');

test('online backup is valid and replaces the previous successful backup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newrss-backup-'));
  const nativeDirectory = path.join(directory, 'native');
  const outputDirectory = path.join(directory, 'output');
  const dbPath = path.join(nativeDirectory, 'newrss.db');
  fs.mkdirSync(nativeDirectory);
  fs.mkdirSync(outputDirectory);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);');
  db.prepare('INSERT INTO items (title) VALUES (?)').run('first');
  db.prepare('INSERT INTO items (title) VALUES (?)').run('second');

  const previousBackup = path.join(outputDirectory, 'newrss-20260721T033000Z.sqlite');
  const unrelatedFile = path.join(outputDirectory, 'keep.txt');
  fs.writeFileSync(previousBackup, 'previous');
  fs.writeFileSync(unrelatedFile, 'keep');

  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const result = await runBackup({
    dbPath,
    nativeTempDir: nativeDirectory,
    outputDir: outputDirectory,
    now: new Date('2026-07-22T03:30:00.000Z'),
  });

  assert.equal(path.basename(result.path), 'newrss-20260722T033000Z.sqlite');
  assert.deepEqual(result.removedBackups, ['newrss-20260721T033000Z.sqlite']);
  assert.equal(fs.existsSync(previousBackup), false);
  assert.equal(fs.readFileSync(unrelatedFile, 'utf8'), 'keep');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

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
  assert.deepEqual(fs.readdirSync(outputDirectory), ['newrss-20260721T033000Z.sqlite']);
});
