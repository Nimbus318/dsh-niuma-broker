const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function cursorCareerUrl(slug) {
  return typeof slug === 'string' && slug.length <= 180 && SLUG.test(slug)
    ? 'https://cursor.com/careers/' + slug : '';
}

// Cursor renders a visible link AND a structured listing containing the Ashby ID
// for each of its branded JDs. Never infer a permalink from the job title.
export function cursorDirectoryLinks(html) {
  const anchors = new Set(Array.from(html.matchAll(/<a\b[^>]*?\shref="\/careers\/([a-z0-9-]+)"/giu), match => match[1]));
  const ids = new Map();
  const slugs = new Map();
  const chunks = [];
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>\s*self\.__next_f\.push\((\[1,[\s\S]*?\])\)\s*<\/script>/gu)) {
    try {
      const chunk = JSON.parse(match[1])[1];
      if (typeof chunk === 'string') chunks.push(chunk);
    } catch { /* Skip data frames that are not JSON. */ }
  }
  for (const line of chunks.flatMap(chunk => chunk.split('\n'))) {
    if (!line.includes('"urlSlug"') || !/^[a-f0-9]+:[[{]/u.test(line)) continue;
    let model;
    try { model = JSON.parse(line.slice(line.indexOf(':') + 1)); } catch { continue; }
    const stack = [model];
    while (stack.length) {
      const entry = stack.pop();
      if (!entry || typeof entry !== 'object') continue;
      if (!Array.isArray(entry.jobs)) {
        for (const child of Object.values(entry)) if (child && typeof child === 'object') stack.push(child);
        continue;
      }
      for (const job of entry.jobs) {
        const slug = job?.urlSlug;
        if (!UUID.test(job?.id) || job?.isListed !== true || !cursorCareerUrl(slug) ||
            !anchors.has(slug) || job.jobUrl !== 'https://jobs.ashbyhq.com/cursor/' + job.id) continue;
        ids.set(job.jobUrl, ids.has(job.jobUrl) && ids.get(job.jobUrl) !== slug ? '' : slug);
        slugs.set(slug, slugs.has(slug) && slugs.get(slug) !== job.jobUrl ? '' : job.jobUrl);
      }
    }
  }
  return new Map([...ids].filter(([id, slug]) => slug && slugs.get(slug) === id));
}
