import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = 'apps/drive/migrations';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const committed = (...args) => execFileSync('git', args, { cwd: repo });
const names = committed('ls-tree', '--name-only', '-z', `HEAD:${directory}`).toString().slice(0, -1).split('\0');
const migrations = names.map(name => [name, committed('show', `HEAD:${directory}/${name}`)]);

export function stageReviewedD1FixtureMigrations(cwd) {
  mkdirSync(join(cwd, directory));
  for (const [name, bytes] of migrations) writeFileSync(join(cwd, directory, name), bytes);
  return names;
}

export function applyReviewedD1FixtureMigrations(db, limit) {
  // The native ledger DDL from pinned Wrangler 4.160.1 is part of the catalog.
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`);
  db.exec('PRAGMA foreign_keys = ON');
  const insert = db.prepare('INSERT INTO d1_migrations VALUES (?, ?, ?)');
  for (const [index, [name, bytes]] of migrations.slice(0, limit).entries()) {
    db.exec(bytes.toString('utf8'));
    insert.run(index + 1, name, '2026-11-20 10:00:00');
  }
}
