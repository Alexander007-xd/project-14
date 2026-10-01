import './env.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, normalize, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  saveItem,
  listItems,
  allTags,
  stats,
  getItem,
  itemIdFor,
  updateStatus,
  updateTags,
  deleteItem,
  savedBetween,
  pickTryToday,
  featuredToday,
  setFeatured,
} from './db.js';
import { fetchMeta } from './fetch-meta.js';
import { aiEnrich, aiEnabled, cleanRawTitle } from './enrich.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const PORT = Number(process.env.PORT ?? 3100);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((ok, fail) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) {
        fail(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new Error('Invalid JSON body'));
      }
    });
    req.on('error', fail);
  });

const normalizeUrl = (input) => {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('URL is required');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) links are supported');
  url.hash = '';
  return url;
};

// Round-trip-safe dedupe key: same page saved with/without trailing slash or www.
const urlKeyFor = (url) => {
  const u = new URL(url);
  u.hostname = u.hostname.replace(/^www\./, '');
  let p = u.pathname;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return `${u.protocol}//${u.hostname}${p}${u.search}`.toLowerCase();
};

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const weekWindow = (offsetWeeks = 0) => {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  const next = new Date(monday);
  next.setDate(monday.getDate() + 7);
  return { start: monday, end: next };
};

const toSqlite = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

async function saveFromUrl(input) {
  const url = normalizeUrl(input);
  const inputKey = urlKeyFor(url.href);

  const meta = await fetchMeta(url.href);
  const enriched = await aiEnrich(meta);

  const finalUrl = meta.url || url.href;
  // A redirect can land on a different path than the one submitted, so either
  // key counts as "already stashed".
  const existed = [inputKey, urlKeyFor(finalUrl)].some((k) => itemIdFor(k) !== null);

  const item = saveItem({
    url: finalUrl,
    urlKey: urlKeyFor(finalUrl),
    title: cleanRawTitle(meta.title, meta.host) || url.hostname,
    displayTitle: enriched.title,
    description: meta.description,
    host: meta.host,
    kind: meta.kind,
    summary: enriched.summary,
    useCase: enriched.useCase,
    tags: enriched.tags,
    source: enriched.source,
    error: meta.error ?? enriched.error ?? null,
  });

  return { item, existed: Boolean(existed) };
}

// ---------------------------------------------------------------- API routes

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/health$/, async (_req, res) => {
  json(res, 200, { ok: true, ai: aiEnabled, stats: stats() });
});

route('POST', /^\/api\/items$/, async (req, res) => {
  const body = await readBody(req);
  const { item, existed } = await saveFromUrl(body.url);
  json(res, existed ? 200 : 201, { item, updated: existed });
});

route('GET', /^\/api\/items$/, async (req, res, _m, url) => {
  const tags = (url.searchParams.get('tags') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const { items, total } = listItems({
    q: (url.searchParams.get('q') ?? '').trim(),
    tags,
    status: (url.searchParams.get('status') ?? '').trim(),
    host: (url.searchParams.get('host') ?? '').trim(),
    limit: Math.min(Number(url.searchParams.get('limit') ?? 200), 500),
    offset: Number(url.searchParams.get('offset') ?? 0),
  });
  json(res, 200, { items, total, tags: allTags(), stats: stats() });
});

route('GET', /^\/api\/items\/(\d+)$/, async (_req, res, m) => {
  const item = getItem(Number(m[1]));
  if (!item) return json(res, 404, { error: 'Not found' });
  json(res, 200, { item });
});

route('PATCH', /^\/api\/items\/(\d+)$/, async (req, res, m) => {
  const id = Number(m[1]);
  const body = await readBody(req);
  let item = getItem(id);
  if (!item) return json(res, 404, { error: 'Not found' });

  if (body.status !== undefined) {
    try {
      item = updateStatus(id, body.status);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (Array.isArray(body.tags)) {
    item = updateTags(
      id,
      [...new Set(body.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 8),
    );
  }
  json(res, 200, { item, stats: stats() });
});

route('DELETE', /^\/api\/items\/(\d+)$/, async (_req, res, m) => {
  if (!deleteItem(Number(m[1]))) return json(res, 404, { error: 'Not found' });
  json(res, 200, { ok: true, stats: stats() });
});

route('POST', /^\/api\/items\/(\d+)\/re-enrich$/, async (_req, res, m) => {
  const id = Number(m[1]);
  const item = getItem(id);
  if (!item) return json(res, 404, { error: 'Not found' });

  const meta = await fetchMeta(item.url);
  const enriched = await aiEnrich({
    ...meta,
    title: item.title || meta.title,
    description: item.description || meta.description,
  });

  json(res, 200, { item: saveItem({
    url: meta.url || item.url,
    urlKey: urlKeyFor(meta.url || item.url),
    title: cleanRawTitle(meta.title, meta.host) || item.title,
    displayTitle: enriched.title,
    description: meta.description || item.description,
    host: meta.host || item.host,
    kind: meta.kind || item.kind,
    summary: enriched.summary,
    useCase: enriched.useCase,
    tags: enriched.tags,
    source: enriched.source,
    error: meta.error ?? enriched.error ?? null,
  }) });
});

route('GET', /^\/api\/tags$/, async (_req, res) => json(res, 200, { tags: allTags() }));

route('GET', /^\/api\/try-today$/, async (_req, res) => {
  const key = localDay();
  let pick = featuredToday(key);
  if (!pick?.item) {
    const candidate = pickTryToday();
    if (candidate) pick = setFeatured(key, candidate.id);
  }
  json(res, 200, {
    date: key,
    item: pick?.item ?? null,
    remaining: stats().untried,
  });
});

route('POST', /^\/api\/try-today\/reshuffle$/, async (_req, res) => {
  const key = localDay();
  const candidate = pickTryToday();
  if (!candidate) return json(res, 404, { error: 'Nothing untried left' });
  json(res, 200, { date: key, item: setFeatured(key, candidate.id).item, remaining: stats().untried });
});

route('GET', /^\/api\/digest$/, async (_req, res, _m, url) => {
  const weeksBack = Number(url.searchParams.get('weeks') ?? 0);
  const { start, end } = weekWindow(-weeksBack);
  const items = savedBetween(toSqlite(start), toSqlite(end));

  const tagCounts = new Map();
  const hostCounts = new Map();
  const kindCounts = new Map();
  for (const it of items) {
    for (const t of it.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    if (it.host) hostCounts.set(it.host, (hostCounts.get(it.host) ?? 0) + 1);
    kindCounts.set(it.kind, (kindCounts.get(it.kind) ?? 0) + 1);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));

  const marked = items.filter((i) => i.status !== 'untried');
  json(res, 200, {
    weekStart: localDay(start),
    weekEnd: localDay(new Date(end.getTime() - 86_400_000)),
    items,
    summary: {
      saved: items.length,
      marked: marked.length,
      useful: items.filter((i) => i.status === 'useful').length,
      topTags: top(tagCounts, 8),
      topHosts: top(hostCounts, 5),
      kinds: top(kindCounts, 6),
    },
  });
});

// ------------------------------------------------------------ static serving

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(publicDir, normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    // SPA-ish fallback so /digest works on a hard refresh.
    try {
      const html = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': html.length });
      res.end(html);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = url.pathname.match(r.pattern);
    if (!match) continue;
    try {
      return await r.handler(req, res, match, url);
    } catch (err) {
      console.error(`[stash] ${req.method} ${url.pathname} ->`, err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
      return;
    }
  }
  json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`Stash running at http://localhost:${PORT}`);
  console.log(`AI: ${aiEnabled ? 'enabled' : 'no OPENAI_API_KEY set - using metadata heuristics'}`);
});
