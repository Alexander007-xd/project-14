const API_KEY = process.env.OPENAI_API_KEY ?? '';
const BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.STASH_AI_TIMEOUT_MS ?? 25_000);

export const aiEnabled = Boolean(API_KEY);

const SYSTEM = `You enrich saved links in a personal knowledge inbox. Given page metadata, return STRICT JSON only, no prose, no code fences:
{
  "title": "a clean human title, 3-9 words, Title Case, no site name, no emoji, no 'GitHub -' or '| Site' suffixes, no ALL-CAPS spam, no trailing colon",
  "summary": "exactly 2 short lines, each under 110 chars, newline separated, plain text. Line 1: what it is. Line 2: what is in it or what makes it notable.",
  "tags": ["3-5 tags, lowercase, 1-2 words each, no # prefix, specific rather than generic"],
  "use_case": "one line, under 130 chars, starting with a verb, describing a concrete way the user could use this"
}
Rules:
- Never invent features not evidenced in the metadata.
- Prefer concrete technical nouns for tags.
- title must stand alone with no context; the site is shown separately.
- use_case must be an actionable step the reader could take today, not a description of the page.`;

function clip(s, n) {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

const STOP = new Set([
  'this', 'that', 'with', 'from', 'your', 'you', 'are', 'was', 'were', 'have', 'has', 'had',
  'and', 'for', 'the', 'not', 'but', 'all', 'any', 'can', 'will', 'its', 'it', 'our', 'out',
  'use', 'using', 'used', 'via', 'new', 'one', 'two', 'get', 'got', 'see', 'how', 'what', 'why',
  'free', 'open', 'source', 'code', 'https', 'http', 'www', 'com', 'org', 'net', 'html', 'index',
  'github', 'gitlab', 'https:', 'readme', 'about', 'more', 'into', 'only', 'also', 'then', 'they',
  'their', 'them', 'these', 'those', 'which', 'when', 'where', 'what', 'does', 'here', 'than',
]);

const KIND_TAGS = {
  repo: ['github', 'code'],
  code: ['code'],
  package: ['library', 'package'],
  docs: ['docs', 'reference'],
  paper: ['paper', 'research'],
  video: ['video', 'watch'],
  article: ['article', 'reading'],
  file: ['file'],
  link: [],
};

// Raw <title> tags are often noise: "GitHub - owner/repo: description | Site",
// all-caps notices, emoji, tag suffixes. Strip what the site adds, keep the rest.
export function cleanRawTitle(raw, host = '') {
  let t = clip(raw, 120);
  if (!t) return '';

  // Drop a trailing "| Site Name" or " - Site Name" segment.
  const tail = t.match(/^(.*?)\s*[|—–]\s*[^|—–]{2,40}$/);
  if (tail && tail[1].trim().length > 8 && !/[|]/.test(tail[1])) t = tail[1].trim();

  // "GitHub - owner/repo: the actual description" -> keep the description.
  t = t.replace(/^(?:GitHub|GitLab|Codeberg)\s*[-–—]\s*\S+?\s*:\s*/i, '');
  // "GitHub - owner/repo" with no description -> keep the slug, drop the site word.
  t = t.replace(/^(?:GitHub|GitLab|Codeberg)\s*[-–—]\s*(?=[\w.-]+\/)/i, '');
  // "owner/repo: description" (no site prefix) -> keep the description.
  t = t.replace(/^[\w.-]+\/[\w.-]+:\s+(?=\S)/, '');
  // A bare "owner/repo" with nothing after it is all we have; keep it.
  t = t.replace(/^[\w.-]+\/[\w.-]+\s*$/, (m) => m.trim());

  t = t
    // Trailing ":zap:" / ":rocket:" style emoji tags with nothing after them.
    .replace(/[:\-–—]?\s*[\w]{1,10}[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]+\s*$/iu, '')
    .replace(/[:\-–—]\s*$/, '')
    .replace(/\s*[(\[].{0,90}[)\]]\s*$/, '') // trailing (parenthesised) or [bracketed] aside
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // ALL-CAPS shouting titles are useless; fall back to sentence case.
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 6 && letters === letters.toUpperCase()) {
    t = t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  if (!t || t.length < 3) return host ? `Link on ${host}` : '';
  if (t.length > 90) t = `${t.slice(0, 87).trimEnd()}…`;
  return t;
}

export function heuristicEnrich(meta) {
  const host = meta.host ?? '';
  const bare = host.split('.').slice(-2, -1)[0] || host;
  const title = cleanRawTitle(meta.title, host) || `Link on ${host}`;
  const name = bare;
  const words = new Set(
    `${title} ${meta.description ?? ''}`
      .toLowerCase()
      .split(/[^a-z0-9+#.-]+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );

  const second =
    clip(meta.description, 130) !== title
      ? clip(meta.description, 130)
      : [...words].slice(0, 6).join(' · ');

  const tags = [...new Set([name, ...(KIND_TAGS[meta.kind] ?? []), ...words])]
    .filter((t) => t && t.length > 1 && !/^www$/.test(t) && !/^com$/.test(t))
    .slice(0, 5);

  return {
    title,
    summary: `${title}\n${second || `Saved from ${host}`}`,
    tags,
    use_case: `Open it and decide whether it earns a bookmark in your workflow.`,
    source: 'heuristic',
  };
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object in model output');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function sanitize(raw, meta) {
  const fallback = heuristicEnrich(meta);

  let title = cleanRawTitle(String(raw.title ?? ''), meta.host);
  // If the model just echoed the raw <title> back, we already have the cleaned
  // version of that, so use it rather than showing the noisy original.
  if (!title) title = fallback.title;

  const summaryLines = String(raw.summary ?? '')
    .split('\n')
    .map((l) => clip(l.replace(/^[-*\d.\s]+/, ''), 130))
    .filter(Boolean)
    .slice(0, 2);
  while (summaryLines.length < 2) summaryLines.push(clip(meta.description, 130) || `Saved from ${meta.host}`);
  // A summary that just repeats the title tells the user nothing.
  if (summaryLines.length === 2 && summaryLines[1] === title) {
    summaryLines[1] = clip(meta.description, 130) || `Saved from ${meta.host}`;
  }

  const tags = [...new Set(
    (Array.isArray(raw.tags) ? raw.tags : String(raw.tags ?? '').split(','))
      .map((t) => clip(String(t).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9+.#-]/g, ''), 24))
      .filter((t) => t.length > 1),
  )].slice(0, 5);

  let useCase = clip(raw.use_case, 150);
  if (useCase && !/^(use|try|open|add|apply|run|install|read|borrow|adapt|paste|port|wire|read|explore|compare|borrow)/i.test(useCase)) {
    useCase = `Try it: ${useCase}`;
  }

  return {
    title,
    summary: summaryLines.join('\n'),
    tags: tags.length ? tags : fallback.tags,
    useCase: useCase || fallback.use_case,
    source: 'ai',
  };
}

export async function aiEnrich(meta) {
  if (!aiEnabled) return { ...heuristicEnrich(meta), source: 'heuristic' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const payload = {
      model: MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `URL: ${meta.url}`,
            `Site: ${meta.host}`,
            `Type: ${meta.kind}`,
            `Title: ${clip(meta.title, 200)}`,
            `Meta description: ${clip(meta.description, 400) || '(none)'}`,
            `Page text (may be noisy): ${clip(meta.text, 2500) || '(none)'}`,
          ].join('\n'),
        },
      ],
    };

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY.replace(/^Bearer\s+/i, '')}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty AI response');

    return sanitize(parseJson(content), meta);
  } catch (err) {
    return { ...heuristicEnrich(meta), source: 'heuristic', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
