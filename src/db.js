import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite only exists on Node 22.5+. Hosts often default to Node 18/20,
// where this is a bare "Cannot find module" with no hint about the fix.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    '\nStash needs Node 22.5 or newer (it uses the built-in node:sqlite module).\n' +
      `You are running Node ${process.version}.\n\n` +
      'Fix it by setting the Node version for your app to 22 or 24:\n' +
      '  package.json  -> "engines": { "node": ">=22.5.0" }   (already set here)\n' +
      '  Render/Railway/Fly  -> set NODE_VERSION=22 or 24 in the dashboard\n' +
      '  nvmrc         -> add a file containing "22"\n\n' +
      'Locally: nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.STASH_DB ?? resolve(root, 'data', 'stash.db');

try {
  mkdirSync(dirname(dbPath), { recursive: true });
} catch (err) {
  console.error(`[stash] cannot create the data directory at ${dirname(dbPath)}: ${err.message}`);
  console.error('Set STASH_DB to a writable location, e.g. STASH_DB=/tmp/stash.db');
  process.exit(1);
}

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    NOT NULL,
    url_key     TEXT    NOT NULL UNIQUE,
    title       TEXT    NOT NULL DEFAULT '',
    display_title TEXT NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    host        TEXT    NOT NULL DEFAULT '',
    kind        TEXT    NOT NULL DEFAULT 'link',
    summary     TEXT    NOT NULL DEFAULT '',
    use_case    TEXT    NOT NULL DEFAULT '',
    tags        TEXT    NOT NULL DEFAULT '[]',
    status      TEXT    NOT NULL DEFAULT 'untried',
    saved_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    tried_at    TEXT,
    source      TEXT    NOT NULL DEFAULT 'ai',
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_picks (
    date_key TEXT    PRIMARY KEY,
    item_id  INTEGER REFERENCES items(id) ON DELETE CASCADE,
    picked_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_saved_at ON items(saved_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_status    ON items(status);
`);

const STATUSES = new Set(['untried', 'tried', 'useful', 'skip']);

const insert = db.prepare(`
  INSERT INTO items (url, url_key, title, display_title, description, host, kind, summary, use_case, tags, source, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(url_key) DO UPDATE SET
    title       = excluded.title,
    display_title = excluded.display_title,
    description = excluded.description,
    host        = excluded.host,
    kind        = excluded.kind,
    summary     = excluded.summary,
    use_case    = excluded.use_case,
    tags        = excluded.tags,
    source      = excluded.source,
    error       = excluded.error,
    saved_at    = datetime('now')
  RETURNING *;
`);

const byId = db.prepare('SELECT * FROM items WHERE id = ?');
const byKey = db.prepare('SELECT id FROM items WHERE url_key = ?');
const del = db.prepare('DELETE FROM items WHERE id = ?');
const setStatus = db.prepare(`
  UPDATE items
     SET status = ?,
         tried_at = CASE WHEN ? = 'untried' THEN NULL ELSE COALESCE(tried_at, datetime('now')) END
   WHERE id = ?
   RETURNING *;
`);
const setTags = db.prepare('UPDATE items SET tags = ? WHERE id = ? RETURNING *');

const row = (r) => {
  if (!r) return null;
  const item = { ...r };
  try {
    item.tags = JSON.parse(item.tags);
  } catch {
    item.tags = [];
  }
  return item;
};

export function saveItem(data) {
  return row(
    insert.get(
      data.url,
      data.urlKey,
      data.title ?? '',
      data.displayTitle ?? data.title ?? '',
      data.description ?? '',
      data.host ?? '',
      data.kind ?? 'link',
      data.summary ?? '',
      data.useCase ?? '',
      JSON.stringify(data.tags ?? []),
      data.source ?? 'ai',
      data.error ?? null,
    ),
  );
}

export function getItem(id) {
  return row(byId.get(id));
}

export function itemIdFor(urlKey) {
  const r = byKey.get(urlKey);
  return r ? r.id : null;
}

export function updateStatus(id, status) {
  if (!STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
  return row(setStatus.get(status, status, id));
}

export function updateTags(id, tags) {
  return row(setTags.get(JSON.stringify(tags), id));
}

export function deleteItem(id) {
  return del.run(id).changes > 0;
}

export function listItems({ q = '', tags = [], status = '', host = '', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (q) {
    where.push('(url LIKE ? OR title LIKE ? OR description LIKE ? OR summary LIKE ? OR use_case LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (status && STATUSES.has(status)) {
    where.push('status = ?');
    params.push(status);
  }
  if (host) {
    where.push('host = ?');
    params.push(host);
  }
  for (const tag of tags) {
    where.push('tags LIKE ?');
    params.push(`%"${tag.replace(/"/g, '')}"%`);
  }

  const sql = `
    SELECT * FROM items
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY saved_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(...params, limit, offset);
  const countSql = `SELECT COUNT(*) AS n FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = db.prepare(countSql).get(...params).n;

  return { items: rows.map(row), total };
}

export function allTags() {
  const counts = new Map();
  for (const r of db.prepare('SELECT tags FROM items').all()) {
    let parsed = [];
    try {
      parsed = JSON.parse(r.tags);
    } catch {
      continue;
    }
    for (const t of parsed) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function stats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all();
  const out = { untried: 0, tried: 0, useful: 0, skip: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  out.savedThisWeek = db
    .prepare("SELECT COUNT(*) AS n FROM items WHERE saved_at >= datetime('now', '-7 days')")
    .get().n;
  return out;
}

export function savedBetween(startIso, endIso) {
  return db
    .prepare('SELECT * FROM items WHERE saved_at >= ? AND saved_at < ? ORDER BY saved_at ASC')
    .all(startIso, endIso)
    .map(row);
}

export function pickTryToday() {
  // Untried first, oldest saved first, so the backlog drains fairly.
  return row(
    db
      .prepare("SELECT * FROM items WHERE status = 'untried' ORDER BY saved_at ASC, id ASC LIMIT 1")
      .get(),
  );
}

export function featuredToday(dateKey) {
  const r = db.prepare('SELECT * FROM daily_picks WHERE date_key = ?').get(dateKey);
  if (!r) return null;
  return { ...r, item: byId.get(r.item_id) ? row(byId.get(r.item_id)) : null };
}

export function setFeatured(dateKey, itemId) {
  db.prepare(
    'INSERT INTO daily_picks (date_key, item_id) VALUES (?, ?) ON CONFLICT(date_key) DO UPDATE SET item_id = excluded.item_id',
  ).run(dateKey, itemId);
  return featuredToday(dateKey);
}
