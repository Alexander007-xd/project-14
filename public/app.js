const api = async (path, options) => {
  const res = await fetch(path, {
    headers: options?.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const relTime = (iso) => {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return then.toLocaleDateString();
};

const prettyDate = (iso) =>
  new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });

const view = document.getElementById('view');
const route = location.pathname.replace(/\/+$/, '') || '/';

document.querySelectorAll('nav.tabs a').forEach((a) => {
  const map = { '/': 'inbox', '/try-today': 'try', '/digest': 'digest' };
  a.classList.toggle('active', map[a.getAttribute('href')] === (map[route] ?? 'inbox'));
});

// ------------------------------------------------------------------- inbox

const state = { q: '', status: '', tags: new Set() };

function cardHtml(item) {
  const summary = esc(item.summary).replace(/\n/g, '<br />');
  const tags = item.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
  const statusBtn = (s, label) =>
    `<button class="ghost ${item.status === s ? 'on' : ''}" data-action="status" data-status="${s}" data-id="${item.id}">${label}</button>`;

  return `
  <article class="card is-${item.status}" data-id="${item.id}">
    <div class="top-row">
      <div style="flex:1;min-width:0">
        <h3><a href="${esc(item.display_title || item.title)}" target="_blank" rel="noopener noreferrer">${esc(item.display_title || item.title)}</a></h3>
        <div class="host">${esc(item.host)} · ${relTime(item.saved_at)}</div>
      </div>
      <span class="kind">${esc(item.kind)}</span>
    </div>
    <p class="summary">${summary}</p>
    ${item.use_case ? `<p class="use-case"><b>Use it:</b> ${esc(item.use_case)}</p>` : ''}
    ${item.error ? `<div class="warn-inline">⚠ fetch/enrich note: ${esc(item.error)}</div>` : ''}
    <div class="tags">${tags}</div>
    <div class="actions">
      ${statusBtn('tried', 'Tried')}
      ${statusBtn('useful', 'Useful')}
      ${statusBtn('skip', 'Skip')}
      <span class="spacer"></span>
      ${item.source === 'heuristic' ? `<button class="ghost" data-action="reenrich" data-id="${item.id}" title="Re-read this link with AI">✦ re-read</button>` : ''}
      <a class="link-out" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>
      <button class="ghost" data-action="delete" data-id="${item.id}" aria-label="Delete">✕</button>
    </div>
  </article>`;
}

async function loadInbox() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.tags.size) params.set('tags', [...state.tags].join(','));

  const data = await api(`/api/items?${params}`);
  const statuses = [['', 'All'], ['untried', 'Untried'], ['tried', 'Tried'], ['useful', 'Useful'], ['skip', 'Skipped']];

  view.innerHTML = `
    <section class="save">
      <form id="save-form">
        <input id="save-url" type="url" inputmode="url" placeholder="Paste a link and press Save" autocomplete="off" required />
        <button class="primary" type="submit" id="save-btn">Save</button>
      </form>
      <p class="save-note" id="save-note">Stash fetches the page, then summarizes it. AI off? It falls back to metadata.</p>
    </section>

    <div class="controls">
      <input type="search" id="q" placeholder="Search title, summary, tags…" value="${esc(state.q)}" />
      <div class="chips" id="status-chips">
        ${statuses.map(([v, label]) =>
          `<button class="chip" data-status="${v}" aria-pressed="${state.status === v}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="tagbar" id="tagbar">
      ${data.tags.map(({ tag, count }) =>
        `<button class="chip" data-tag="${esc(tag)}" aria-pressed="${state.tags.has(tag)}">#${esc(tag)}<span class="n">${count}</span></button>`).join('')}
    </div>

    <p class="muted">${data.total} item${data.total === 1 ? '' : 's'} · ${data.stats.untried} untried · ${data.stats.useful} useful</p>
    <div class="grid" id="cards">
      ${data.items.length ? data.items.map(cardHtml).join('') : '<div class="empty">Nothing here yet. Paste a link above.</div>'}
    </div>
    <footer class="bottom">Data lives in <code>data/stash.db</code> — your links, on your machine.</footer>
  `;

  const note = document.getElementById('save-note');
  const form = document.getElementById('save-form');
  const input = document.getElementById('save-url');
  const btn = document.getElementById('save-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    btn.disabled = true;
    note.className = 'save-note';
    note.textContent = 'Fetching and reading…';
    try {
      const { item, updated } = await api('/api/items', { method: 'POST', body: JSON.stringify({ url }) });
      note.className = 'save-note ok';
      note.textContent = `${updated ? 'Updated' : 'Saved'}: ${item.title}`;
      input.value = '';
      await loadInbox();
      note.className = 'save-note ok';
      note.textContent = `${updated ? 'Updated' : 'Saved'}: ${item.title}`;
    } catch (err) {
      note.className = 'save-note err';
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  let timer;
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = q.value.trim();
      loadInbox().then(() => {
        const el = document.getElementById('q');
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    }, 250);
  });

  document.getElementById('status-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (!b) return;
    state.status = b.dataset.status;
    loadInbox();
  });

  document.getElementById('tagbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag;
    state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
    loadInbox();
  });

  document.getElementById('cards').addEventListener('click', onCardAction);
}

async function onCardAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'status') {
    const next = btn.classList.contains('on') ? 'untried' : btn.dataset.status;
    await api(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    await loadInbox();
  } else if (action === 'reenrich') {
    btn.disabled = true;
    btn.textContent = 'reading…';
    try {
      await api(`/api/items/${id}/re-enrich`, { method: 'POST' });
    } catch (err) {
      alert(`Could not re-read: ${err.message}`);
    }
    await loadInbox();
  } else if (action === 'delete') {
    if (!confirm('Delete this item?')) return;
    await api(`/api/items/${id}`, { method: 'DELETE' });
    await loadInbox();
  }
}

// -------------------------------------------------------------- try today

async function loadTryToday() {
  const { item, remaining, date } = await api('/api/try-today');

  view.innerHTML = `
    <section class="panel">
      <h2>Try this today</h2>
      <p class="muted">${prettyDate(date)} · ${remaining} item${remaining === 1 ? '' : 's'} still untried. One a day keeps the stash from becoming a graveyard.</p>
      ${
        item
          ? `<div class="grid" style="margin-top:16px">${cardHtml(item)}</div>`
          : `<div class="empty">Nothing untried left. Save something new, or mark a skipped item back to untried.</div>`
      }
    </section>`;

  const cards = document.getElementById('cards');
  cards?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="status"]');
    if (btn) {
      await api(`/api/items/${btn.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.status }) });
      return loadTryToday();
    }
    const re = e.target.closest('[data-action="reenrich"]');
    if (re) {
      re.disabled = true;
      re.textContent = 'reading…';
      try {
        await api(`/api/items/${re.dataset.id}/re-enrich`, { method: 'POST' });
      } catch (err) {
        alert(`Could not re-read: ${err.message}`);
      }
      return loadTryToday();
    }
  });
}

// ----------------------------------------------------------------- digest

async function loadDigest() {
  const d = await api('/api/digest');
  const { summary, items, weekStart, weekEnd } = d;
  const maxTag = summary.topTags[0]?.count ?? 1;

  view.innerHTML = `
    <section class="panel">
      <h2>Weekly digest</h2>
      <p class="muted">${weekStart} → ${weekEnd}</p>
      <div class="tiles">
        <div class="tile"><b>${summary.saved}</b><span>saved</span></div>
        <div class="tile"><b>${summary.marked}</b><span>reviewed</span></div>
        <div class="tile"><b>${summary.useful}</b><span>useful</span></div>
        <div class="tile"><b>${summary.topHosts.length}</b><span>sites</span></div>
      </div>
    </section>

    <section class="panel">
      <h2>What you leaned toward</h2>
      ${
        summary.topTags.length
          ? `<div class="tiles">${summary.topTags.map(({ key, count }) => `
              <div class="tile"><b>${esc(key)}</b><span>${count} saved</span>
                <div class="bar"><i style="width:${Math.round((count / maxTag) * 100)}%"></i></div>
              </div>`).join('')}</div>`
          : '<p class="muted">No tags yet.</p>'
      }
      ${summary.topHosts.length ? `<p class="muted" style="margin-top:14px">Top sites: ${summary.topHosts.map((h) => esc(h.key)).join(', ')}</p>` : ''}
    </section>

    <section class="panel">
      <h2>Saved this week (${items.length})</h2>
      <div class="grid" style="margin-top:12px">
        ${
          items.length
            ? items.map(cardHtml).join('')
            : '<div class="empty">Nothing saved this week yet.</div>'
        }
      </div>
    </section>
    <footer class="bottom">Older weeks: <code>/api/digest?weeks=1</code></footer>`;

  document.getElementById('cards')?.addEventListener('click', onCardAction);
}

// ------------------------------------------------------------------- boot

try {
  if (route === '/try-today') await loadTryToday();
  else if (route === '/digest') await loadDigest();
  else await loadInbox();
} catch (err) {
  view.innerHTML = `<div class="empty">Could not load: ${esc(err.message)}</div>`;
}
