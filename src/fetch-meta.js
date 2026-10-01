const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Stash/1.0';

const MAX_BYTES = 400_000;

const decode = (s) => {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
};

const meta = (html, ...names) => {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${name}["'][^>]*>`,
      'i',
    );
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content = tag.match(/content\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (content?.trim()) return decode(content);
  }
  return '';
};

const jsonLd = (html) => {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes.flatMap((n) => (n?.['@graph'] ? [n, ...n['@graph']] : [n]))) {
        if (!node || typeof node !== 'object') continue;
        const desc = typeof node.description === 'string' ? node.description : '';
        const name = typeof node.name === 'string' ? node.name : '';
        if (desc || name) return { title: name, description: desc };
      }
    } catch {
      /* ignore malformed ld+json */
    }
  }
  return {};
};

const stripTags = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );

const detectKind = (url, html) => {
  const text = `${url} ${html.slice(0, 20_000)}`.toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com/.test(new URL(url).hostname)) return 'video';
  if (/github\.com|gitlab\.com|codeberg\.org/.test(new URL(url).hostname)) return 'repo';
  if (/\/pull\/\d+|\/issues\/\d+/.test(new URL(url).pathname)) return 'code';
  if (/npmjs\.com|pypi\.org|crates\.io|packagist\.org|rubygems\.org|docker\.hub/.test(new URL(url).hostname))
    return 'package';
  if (/(docs\.|developer\.|readthedocs|devdocs|\/docs\/|\/documentation\/)/.test(text)) return 'docs';
  if (/arxiv\.org|doi\.org|paperswithcode|nature\.com|springer|acm\.org|ieee/.test(new URL(url).hostname))
    return 'paper';
  if (/medium\.com|substack\.com|dev\.to|hashnode|blogspot|wordpress/.test(new URL(url).hostname))
    return 'article';
  if (/\.(pdf)$/i.test(new URL(url).pathname)) return 'paper';
  return 'link';
};

// A few hosts serve no useful HTML to a plain fetch. Their own APIs do.
async function knownHostMeta(target) {
  const host = target.hostname.replace(/^www\./, '');
  const isVideo = /youtube\.com|youtu\.be|vimeo\.com/.test(host);

  if (!isVideo) return null;

  try {
    const oembed = /youtu\.?be/.test(host)
      ? `https://www.youtube.com/oembed?url=${encodeURIComponent(target.href)}&format=json`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(target.href)}`;
    const res = await fetch(oembed, { headers: { 'user-agent': UA } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      kind: 'video',
      title: decode(data.title ?? ''),
      description: decode(`${data.author_name ? `${data.author_name} · ` : ''}${data.description ?? data.title ?? ''}`),
      text: '',
    };
  } catch {
    return null;
  }
}

export async function fetchMeta(url) {
  const known = await knownHostMeta(new URL(url));
  if (known) {
    const u = new URL(url);
    return { url: u.href, host: u.hostname.replace(/^www\./, ''), status: 200, error: null, ...known };
  }

  const target = new URL(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });

    const contentType = res.headers.get('content-type') ?? '';
    const base = {
      url: res.url || target.href,
      host: target.hostname.replace(/^www\./, ''),
      status: res.status,
    };

    if (!res.ok) {
      return { ...base, kind: detectKind(target.href, ''), title: '', description: '', text: '', error: `HTTP ${res.status}` };
    }

    if (!/text\/html|application\/xhtml|text\/plain|json/.test(contentType)) {
      return { ...base, kind: 'file', title: target.pathname.split('/').pop() || target.hostname, description: contentType, text: '', error: null };
    }

    const buf = await res.arrayBuffer();
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_BYTES));

    const ld = jsonLd(html);
    const title =
      meta(html, 'og:title', 'twitter:title') ||
      ld.title ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      target.hostname;
    const description =
      meta(html, 'og:description', 'twitter:description', 'description') || ld.description || '';

    const bodyText = stripTags(html).slice(0, 6000);

    return {
      ...base,
      kind: detectKind(res.url || target.href, html),
      title: decode(title),
      description: decode(description),
      text: bodyText,
      error: null,
    };
  } catch (err) {
    // Some hosts (docs.sqlite.org, many CDNs) reject the default UA or need
    // the bare host. One cheap retry before giving up.
    const alt = target.hostname.startsWith('www.') ? target.href.replace('//www.', '//') : `${target.href}?`;
    try {
      const res = await fetch(alt, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'user-agent': 'curl/8.4.0',
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const html = await res.text();
      const ld = jsonLd(html);
      return {
        url: res.url || alt,
        host: new URL(alt).hostname.replace(/^www\./, ''),
        status: res.status,
        kind: detectKind(alt, html),
        title: decode(meta(html, 'og:title', 'twitter:title') || ld.title || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
        description: decode(meta(html, 'og:description', 'twitter:description', 'description') || ld.description || ''),
        text: stripTags(html).slice(0, 6000),
        error: null,
      };
    } catch {
      return {
        url: target.href,
        host: target.hostname.replace(/^www\./, ''),
        status: 0,
        kind: detectKind(target.href, ''),
        title: target.hostname,
        description: '',
        text: '',
        error: err.name === 'AbortError' ? 'Timed out fetching page' : `Could not fetch page (${err.message})`,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
