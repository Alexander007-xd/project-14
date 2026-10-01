# Stash

A personal inbox for useful links. Paste a link, and Stash fetches the page, reads it, and files it as a card with a summary, tags, and a concrete way to use it. Later you mark items Tried / Useful / Skip, get one untried suggestion a day, and a weekly digest of what you collected.

## Run it

```bash
npm start          # http://localhost:3100
PORT=4000 npm start  # or pick your own
```

Node 22.5+ only. No dependencies, no build step — it uses the built-in `node:sqlite` and `node:http`.

## AI setup (optional)

Without a key, Stash still works: it falls back to metadata heuristics (title, description, site name) so you can use it immediately. For real summaries, set:

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1   # optional, any OpenAI-compatible endpoint
OPENAI_MODEL=gpt-4o-mini                     # optional
```

Put those three in `.env` (see `.env.example`); Stash loads it automatically at startup, so `npm start` is all you need. Real environment variables take precedence over `.env`. The same setup works for DeepSeek, OpenRouter, Groq, Together, or a local Ollama (`OPENAI_BASE_URL=http://localhost:11434/v1`, any model name you have pulled).

The AI writes four things per link: a clean standalone title, a two-line summary, 3–5 tags, and one actionable line. The title is generated rather than copied from the page, so `GitHub - sindresorhus/awesome-nodejs: :zap: Delightful Node.js packages… [BECAUSE OF TOO MUCH SPAM…]` becomes `awesome-nodejs curated package list`.

If the AI call fails or times out, the item is still saved and marked `source: heuristic` with the error recorded on the card, so nothing is ever lost.

## Pages

| Route | What it does |
| --- | --- |
| `/` | Inbox: save box, search, status and tag filters, cards |
| `/try-today` | One untried item per day, chosen oldest-first so the backlog drains |
| `/digest` | Everything saved this week, plus tag/site breakdowns |

## API

```
GET    /api/health
POST   /api/items              { url }        → saves, fetches, enriches (201 new / 200 updated)
GET    /api/items?q=&tags=&status=&host=&limit=&offset=
GET    /api/items/:id
PATCH  /api/items/:id          { status?, tags? }   status: untried|tried|useful|skip
DELETE /api/items/:id
POST   /api/items/:id/re-enrich   → re-fetch and re-run AI on an existing item
GET    /api/tags
GET    /api/try-today          → today's pick, stable for the whole day
POST   /api/try-today/reshuffle
GET    /api/digest?weeks=0     → current week (1 = previous week)
```

Re-saving the same link updates it in place instead of creating a duplicate; the dedupe key ignores `www`, trailing slashes, and case, and follows redirects before comparing.

## Data

Everything lives in `data/stash.db` (SQLite, WAL mode). Back it up by copying the file. Set `STASH_DB` to point elsewhere.

## Layout

```
src/server.js     routing, static files, save pipeline
src/db.js         schema + queries
src/fetch-meta.js page fetch, metadata extraction, YouTube/Vimeo oEmbed fallback
src/enrich.js     AI summary/tags/use-case, heuristic fallback
public/           index.html, app.js, styles.css
```
