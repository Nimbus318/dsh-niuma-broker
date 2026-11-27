import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyResumeConversation, resumeBullet } from './resume-conversation.mjs';
import { resolveTrackId } from './resume-versions.mjs';
import { expandHex } from './resume-style.mjs';
import { BRICK_TTL_MS, MAX_EXCLUSION_RULES, pruneWorkBricks, rollupWorkBricks } from './watch.mjs';

const VALID_FONTS = new Set(['sans', 'serif']);
const VALID_DENSITIES = new Set(['compact', 'balanced', 'airy']);

function sanitizeAppearance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.template === 'string' && /^[a-z0-9-]{2,40}$/u.test(raw.template.trim().toLowerCase())) {
    out.template = raw.template.trim().toLowerCase();
  }
  if (raw.style && typeof raw.style === 'object' && !Array.isArray(raw.style)) {
    const style = {};
    const accent = expandHex(raw.style.accent);
    if (accent) style.accent = accent;
    if (VALID_FONTS.has(raw.style.font)) style.font = raw.style.font;
    if (VALID_DENSITIES.has(raw.style.density)) style.density = raw.style.density;
    if (Object.keys(style).length) out.style = style;
  }
  return Object.keys(out).length ? out : undefined;
}

const modes = new Set(['off', 'observe', 'search']);
const dimensions = new Set(['growth', 'scope', 'compensation', 'workload', 'values', 'direction']);
const severities = new Set(['concern', 'neutral', 'positive']);
const defaults = Object.freeze({
  timezone: 'Asia/Shanghai',
  notificationHour: 20,
  notificationEndHour: 23,
  notificationsEnabled: false,
  allowReflections: false,
});
const dayMs = 86_400_000;
const concernsWindow = 30 * dayMs;
const reminderCooldown = 14 * dayMs;

function requiredString(value, name, max = 6000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty string up to ${max} characters.`);
  }
  return value.trim();
}

function optionalString(value, name, max) {
  return value === undefined || value === null || value === '' ? undefined : requiredString(value, name, max);
}

function values(input, name, max) {
  if (!Array.isArray(input) || input.length > max) {
    throw new Error(`${name} must be an array with at most ${max} entries.`);
  }
  return input;
}

function dateString(value, name = 'occurredAt') {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/T.*(?:Z|[+\-]\d{2}:\d{2})$/i.test(value))) {
    throw new Error(`${name} must be an ISO timestamp with a time zone.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid.`);
  return date.toISOString();
}

function shortId(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function emptyState() {
  return {
    schemaVersion: 1,
    mode: 'off',
    sources: [],
    preferences: { ...defaults },
    events: [],
    evidence: [],
    reflections: [],
    resumes: [],
    suggestions: [],
    workBricks: [],
    exclusions: [],
  };
}

function choice(value, allowed, name) {
  if (!allowed.has(value)) throw new Error(`${name} must be one of ${[...allowed].join(', ')}.`);
  return value;
}

const scopedProjects = Symbol('scopedProjects');

function isAuthorized(state, sourceId, projectId) {
  return state.sources.some((source) => source.id === sourceId && !source.revokedAt &&
    (state[scopedProjects]?.get(sourceId)?.has(projectId) ||
      source.projects.includes(projectId) || source.projects.includes('*')));
}

function findRecord(records, id, label) {
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`Unknown ${label} ${id}.`);
  return record;
}

function active(state) {
  if (state.mode === 'off') throw new Error('Career Agent is off.');
}

function review(record, action, now) {
  switch (action) {
    case 'approve':
    case 'reject':
      if (record.status !== 'pending') throw new Error('Only a pending record can be approved or rejected.');
      record.status = action === 'approve' ? 'approved' : 'rejected';
      break;
    case 'revoke':
      if (!['approved', 'pending'].includes(record.status)) throw new Error('The record cannot be revoked.');
      record.status = 'revoked';
      break;
    default:
      throw new Error('Action must be approve, reject or revoke.');
  }
  record.reviewedAt = now;
}

function trimEvidence(input, event, index, now) {
  const reasonTag = optionalString(input.reasonTag, 'Evidence reason tag', 32);
  const reasonText = optionalString(input.reasonText, 'Evidence reason text', 240);
  return {
    id: shortId(event.key, index),
    eventId: event.id,
    eventKey: event.key,
    sourceId: event.sourceId,
    projectId: event.projectId,
    sourceRef: event.sourceRef,
    kind: event.kind,
    occurredAt: event.occurredAt,
    title: requiredString(input.title, 'Evidence title', 180),
    text: requiredString(input.text, 'Evidence text'),
    role: optionalString(input.role, 'Evidence role', 1200),
    impact: optionalString(input.impact, 'Evidence impact', 2000),
    ...(reasonTag ? { reasonTag } : {}),
    ...(reasonText ? { reasonText } : {}),
    createdAt: now,
    status: 'pending',
    shareable: false,
  };
}

function referencedEvidence(state, ids, shareable = false) {
  return ids.map((id) => {
    const evidence = findRecord(state.evidence, id, 'evidence');
    if (evidence.status !== 'approved' ||
        !isAuthorized(state, evidence.sourceId, evidence.projectId) ||
        (shareable && !evidence.shareable)) {
      throw new Error(`Evidence ${id} requires active human approval${shareable ? ' for external use' : ''}.`);
    }
    return evidence;
  });
}

function uniqueIds(input, name) {
  return [...new Set(values(input, name, 50).map((id) => requiredString(id, name, 128)))];
}

function reflectionActive(state, record) {
  if (record.status !== 'approved') return false;
  if (record.sourceId && !isAuthorized(state, record.sourceId, record.projectId)) return false;
  return record.evidenceIds.every((id) => {
    const evidence = state.evidence.find((item) => item.id === id);
    return evidence?.status === 'approved' && isAuthorized(state, evidence.sourceId, evidence.projectId);
  });
}

function isBrickPreErasure(state, brick) {
  const source = state.sources.find((row) => row.id === brick?.sourceId);
  if (!source?.forgottenAt) return false;
  return !brick.occurredAt || brick.occurredAt <= source.forgottenAt;
}

function isBrickActive(state, brick, nowMs) {
  if (state.mode === 'off') return false;
  if (!brick || typeof brick !== 'object' || brick.promotedAt) return false;
  const ts = Date.parse(brick.occurredAt || '');
  if (!Number.isFinite(ts) || ts < nowMs - BRICK_TTL_MS) return false;
  if (isBrickPreErasure(state, brick)) return false;
  return isAuthorized(state, brick.sourceId, brick.projectId);
}

function activeExclusions(state) {
  const rows = Array.isArray(state.exclusions) ? state.exclusions : [];
  return rows.filter((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.text !== 'string' || !entry.text.trim()) return false;
    if (!entry.sourceId) return true;
    const source = state.sources.find((row) => row.id === entry.sourceId);
    if (!source || source.revokedAt) return false;
    if (source.forgottenAt) {
      if (entry.createdAt && entry.createdAt <= source.forgottenAt) return false;
      if (entry.evidenceId && !state.evidence.some((ev) => ev.id === entry.evidenceId)) return false;
    }
    return entry.projectId
      ? isAuthorized(state, entry.sourceId, entry.projectId)
      : state.sources.some((row) => row.id === entry.sourceId && !row.revokedAt && row.projects.length > 0);
  });
}

function dateKey(timestamp, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp));
}

function updateSuggestions(state, now) {
  if (!state.preferences.allowReflections || !state.preferences.notificationsEnabled) return;
  const nowMs = Date.parse(now);
  for (const dimension of dimensions) {
    const recent = state.reflections
      .filter((row) => row.dimension === dimension && reflectionActive(state, row) &&
        Date.parse(row.occurredAt) >= nowMs - concernsWindow && Date.parse(row.occurredAt) <= nowMs)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const lastPositive = recent.findLastIndex((row) => row.severity === 'positive');
    const days = new Map();
    const usedEvents = new Set();
    for (const reflection of recent.slice(lastPositive + 1)) {
      if (reflection.severity !== 'concern') continue;
      const day = dateKey(reflection.occurredAt, state.preferences.timezone);
      const eventKeys = [
        ...reflection.evidenceIds.map((id) => state.evidence.find((row) => row.id === id)?.eventKey),
        reflection.eventKey,
      ].filter(Boolean);
      if (days.has(day) || eventKeys.some((key) => usedEvents.has(key))) continue;
      days.set(day, reflection);
      for (const key of eventKeys) usedEvents.add(key);
    }
    if (days.size < 2) continue;
    const witnesses = [...days.values()];
    const reflectionIds = witnesses.map((entry) => entry.id);
    const latest = witnesses.at(-1);
    const prior = state.suggestions.filter((item) => item.dimension === dimension).at(-1);
    if (prior && (Date.parse(now) - Date.parse(prior.createdAt) < reminderCooldown ||
        latest.occurredAt <= prior.latestReflectionAt)) continue;
    state.suggestions.push({
      id: shortId('suggestion', dimension, reflectionIds),
      kind: dimension === 'direction' ? 'search-intent-check' : 'growth-check',
      dimension,
      reflectionIds,
      latestReflectionAt: latest.occurredAt,
      createdAt: now,
      status: 'pending',
      title: dimension === 'direction' ? '确认是否开启求职计划' : '回顾近期职业发展情况',
      text: dimension === 'direction'
        ? '你在不同日期记录了相近的职业方向疑问。可以确认是否继续观察、做小范围机会探索，或正式开启找工作计划。'
        : '你在不同日期记录了同一类顾虑。可以对照最近的变化、原本的期待和现有证据，选一个想了解或尝试的下一步。',
    });
  }
}

function duringNotificationHours(preferences, now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: preferences.timezone,
  }).format(new Date(now)));
  const start = preferences.notificationHour;
  const end = preferences.notificationEndHour;
  if (start === end) return hour === start;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function currentSuggestion(state, entry, now) {
  if (entry.status !== 'pending') return false;
  if (Date.parse(entry.latestReflectionAt) < Date.parse(now) - concernsWindow) return false;
  if (!entry.reflectionIds.every((id) => {
    const reflection = state.reflections.find((row) => row.id === id);
    return reflection && reflectionActive(state, reflection);
  })) return false;
  return !state.reflections.some((row) => row.dimension === entry.dimension &&
    row.severity === 'positive' && row.occurredAt > entry.latestReflectionAt && reflectionActive(state, row));
}

function adaptedLine(value) {
  const line = requiredString(value, 'Tailored resume line', 6000);
  if (/[\r\n]/u.test(line)) throw new Error('Each rewritten experience must fit on a single line.');
  return resumeBullet.exec(line)?.[2] ?? line;
}

export function tailorableResumeLines(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return lines.filter(line => resumeBullet.test(line) && counts.get(line) === 1);
}

export function rewriteResume(markdown, items) {
  const base = markdown.split(/\r?\n/u);
  const eligible = new Set(tailorableResumeLines(markdown));
  const selections = new Set();
  const groupBySource = new Map();
  const groups = [];
  const following = Array(base.length);
  let next = '';
  for (let index = base.length - 1; index >= 0; index -= 1) {
    following[index] = next;
    if (base[index].trim()) next = base[index];
  }
  let current;
  base.forEach((line, index) => {
    const bullet = resumeBullet.exec(line);
    if (!bullet) { current = null; return; }
    const [, prefix, text] = bullet;
    const indentation = value => value.match(/^[ \t]*/u)[0].length;
    // A nested list or indented continuation stays attached to the original parent.
    const hasContinuation = indentation(following[index]) > indentation(prefix);
    const style = prefix.replace(/\d+/u, '#') + (hasContinuation ? `@${index}` : '');
    if (current?.style !== style) {
      current = { style, original: [], ranked: [] };
      groups.push(current);
    }
    current.original.push({ line, index, prefix, text });
    if (eligible.has(line)) groupBySource.set(line, current);
  });
  for (const item of items) {
    if (!eligible.has(item.source) || selections.has(item.source)) {
      throw new Error('Each rewritten experience must match one unique line in the approved resume.');
    }
    selections.add(item.source);
    groupBySource.get(item.source).ranked.push(item.text);
  }
  for (const group of groups) {
    if (!group.ranked.length) continue;
    const words = [...group.ranked, ...group.original.filter(row => !selections.has(row.line)).map(row => row.text)];
    group.original.forEach((row, index) => { base[row.index] = `${row.prefix}${words[index]}`; });
  }
  return base.join(markdown.includes('\r\n') ? '\r\n' : '\n');
}

export function resumeEvidenceIds(resumes, startId) {
  const ids = new Set();
  if (!startId) return ids;
  const byId = new Map(resumes.map(r => [r.id, r]));
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const curId = queue.shift();
    if (!curId || visited.has(curId)) continue;
    visited.add(curId);
    const row = byId.get(curId);
    if (!row) {
      if (curId === startId) findRecord(resumes, curId, 'base resume');
      continue;
    }
    if (row.kind === 'generated' && Array.isArray(row.items)) {
      for (const item of row.items) {
        for (const id of (item.evidenceIds ?? [])) ids.add(id);
      }
    }
    if (Array.isArray(row.evidenceIds)) {
      for (const id of row.evidenceIds) ids.add(id);
    }
    for (const refId of [row.baseId, row.parentId, row.branchedFromId]) {
      if (refId && !visited.has(refId)) queue.push(refId);
    }
  }
  return ids;
}

function resumeMarkdown(state, resume, visited = new Set()) {
  if (visited.has(resume.id)) throw new Error('The resume version history is circular.');
  visited.add(resume.id);
  if (Array.isArray(resume.evidenceIds) && resume.evidenceIds.length) {
    referencedEvidence(state, resume.evidenceIds, true);
  }
  if (resume.kind === 'import') return resume.text;
  if (resume.kind === 'revised') {
    if (resume.baseId) {
      const base = findRecord(state.resumes, resume.baseId, 'base resume');
      if (!['pending', 'approved'].includes(base.status)) throw new Error('这版简历的原稿已经撤销或忽略。');
      resumeMarkdown(state, base, visited);
    }
    return resume.text;
  }
  if (resume.kind === 'tailored') {
    if (!resume.baseId && typeof resume.text === 'string') return resume.text;
    const base = findRecord(state.resumes, resume.baseId, 'base resume');
    if (resume.variant === 'conversation') {
      if (!['pending', 'approved'].includes(base.status)) throw new Error('这版简历的原稿已经撤销或忽略。');
      return applyResumeConversation(resumeMarkdown(state, base, visited), resume.items);
    }
    if (base.status !== 'approved') throw new Error('A base resume requires explicit human approval.');
    return rewriteResume(resumeMarkdown(state, base, visited), resume.items);
  }
  if (!resume.baseId && typeof resume.text === 'string' && resume.text.trim()) {
    return resume.text;
  }
  referencedEvidence(state, [...new Set(resume.items.flatMap((item) => item.evidenceIds))], true);
  const heading = resume.title.replaceAll(/[\r\n]+/g, ' ');
  const bullets = resume.items.map((item) => `- ${item.text.replaceAll(/[\r\n]+/g, ' ')}`).join('\n');
  if (resume.baseId) {
    const base = findRecord(state.resumes, resume.baseId, 'base resume');
    if (base.status !== 'approved') throw new Error('A base resume requires explicit human approval.');
    if (base.kind === 'tailored' && !(base.variant === 'conversation' && base.general && !base.opportunityId)) {
      throw new Error('A job-specific resume cannot become the general resume.');
    }
    if (base.kind === 'revised' && (base.opportunityId || base.general !== true)) {
      throw new Error('A job-specific resume cannot become the general resume.');
    }
    const text = resumeMarkdown(state, base, visited).trimEnd();
    if (typeof resume.mergedText === 'string' && resume.mergedText.trim()) {
      return `${resume.mergedText.trimEnd()}\n`;
    }
    return base.kind === 'generated' && base.title === resume.title
      ? `${text}\n${bullets}\n`
      : `${text}\n\n## ${heading}\n\n${bullets}\n`;
  }
  if (typeof resume.mergedText === 'string' && resume.mergedText.trim()) {
    return `${resume.mergedText.trimEnd()}\n`;
  }
  return `# ${heading}\n\n${bullets}\n`;
}

function includeDependentResumes(resumes, removed) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const resume of resumes) {
      if (removed.has(resume.id)) continue;
      if (removed.has(resume.baseId) || removed.has(resume.parentId) || removed.has(resume.branchedFromId)) {
        removed.add(resume.id);
        changed = true;
      }
    }
  }
  return removed;
}

function normalizeForMatch(text) {
  return String(text || '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Detects which evidence records were newly absorbed into `nextText` relative to `previousText`.
 * Prevents provenance leaks when a resume incorporates approved evidence via free chat or edits,
 * while never false-matching unrelated hand-written edits.
 */
export function detectAbsorbedEvidenceIds(evidenceList = [], previousText = '', nextText = '') {
  if (!Array.isArray(evidenceList) || !evidenceList.length || typeof nextText !== 'string' || !nextText.trim()) {
    return [];
  }
  const prevLines = new Set(String(previousText || '').split(/\r?\n/u).map(normalizeForMatch).filter(Boolean));
  const addedLines = nextText.split(/\r?\n/u).map(normalizeForMatch).filter(line => line && !prevLines.has(line));
  if (!addedLines.length) return [];
  const addedBlob = addedLines.join('\n');
  const prevBlob = normalizeForMatch(previousText);
  const matched = [];
  for (const ev of evidenceList) {
    if (!ev?.id || ev.status === 'revoked' || ev.status === 'rejected') continue;
    const rawText = String(ev.text || '');
    const rawTitle = String(ev.title || '');
    const normText = normalizeForMatch(rawText);
    const normTitle = normalizeForMatch(rawTitle);
    let hit = false;
    // 1. Direct exact text or title inclusion in added content
    if (normText.length >= 10 && addedBlob.includes(normText) && !prevBlob.includes(normText)) {
      hit = true;
    } else if (normTitle.length >= 10 && addedBlob.includes(normTitle) && !prevBlob.includes(normTitle)) {
      hit = true;
    }
    // 2. Distinctive identifier / marker token (e.g. SYNTHETIC_SHAREABLE_FEAT_3441, project code)
    if (!hit) {
      const tokens = `${rawText} ${rawTitle}`.match(/[A-Za-z0-9][A-Za-z0-9_-]{7,}/gu) || [];
      for (const tok of tokens) {
        const low = tok.toLowerCase();
        if (!/[\d_-]/.test(low) && low.length < 14) continue;
        if (addedBlob.includes(low) && !prevBlob.includes(low)) {
          hit = true;
          break;
        }
      }
    }
    // 3. Distinctive clause (>= 12 chars) or 4-word sequence from evidence text
    if (!hit && normText.length >= 12) {
      const clauses = normText.split(/[，。,.!?;；\n]+/u).map(s => s.trim()).filter(s => s.length >= 12);
      for (const clause of clauses) {
        if (addedBlob.includes(clause) && !prevBlob.includes(clause)) {
          hit = true;
          break;
        }
      }
    }
    if (!hit && normText.length >= 16) {
      const words = normText.split(/\s+/u).filter(Boolean);
      for (let i = 0; i <= words.length - 4; i += 1) {
        const gram = words.slice(i, i + 4).join(' ');
        if (gram.length >= 16 && addedBlob.includes(gram) && !prevBlob.includes(gram)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.push(ev.id);
  }
  return matched;
}

function resumeDirectlyUsesEvidence(row, predicate) {
  if (row.kind === 'generated' && Array.isArray(row.items)
    && row.items.some(item => Array.isArray(item.evidenceIds) && item.evidenceIds.some(predicate))) {
    return true;
  }
  if (Array.isArray(row.evidenceIds) && row.evidenceIds.some(predicate)) {
    return true;
  }
  return false;
}

async function ownerIsGone(lockPath) {
  let owner;
  try {
    owner = Number(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!Number.isInteger(owner) || owner < 1 || owner > 2_147_483_647) return false;
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

async function recoverLock(lockPath) {
  if (!await ownerIsGone(lockPath)) return;
  const recoveryPath = `${lockPath}.recovery`;
  let recovery;
  try {
    recovery = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    // Another writer may already have recovered the stale lock and acquired a new one.
    if (await ownerIsGone(lockPath)) await rm(lockPath);
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}

async function acquireLock(lockPath) {
  const claim = `${lockPath}.${randomUUID()}.claim`;
  await writeFile(claim, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await link(claim, lockPath);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await recoverLock(lockPath);
        await sleep(25);
      }
    }
    throw new Error('Career state is locked. Retry after the active run has ended.');
  } finally {
    await rm(claim, { force: true }).catch(() => {});
  }
}

export async function withFileLock(targetFile, action) {
  await mkdir(dirname(targetFile), { mode: 0o700, recursive: true });
  const lockPath = `${targetFile}.lock`;
  await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

export class CareerStore {
  constructor(options) {
    this.file = resolve(requiredString(options?.file, 'State file'));
    this.now = options.now ?? (() => new Date());
    this.resolveProjects = options.resolveProjects;
  }

  timestamp() {
    return dateString(this.now(), 'Clock');
  }

  async state() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      if (raw.schemaVersion !== 1 || !modes.has(raw.mode) ||
          !['sources', 'events', 'evidence', 'reflections', 'resumes', 'suggestions'].every((key) => Array.isArray(raw[key]))) {
        throw new Error('Career state file has an unsupported format.');
      }
      const state = {
        ...raw,
        preferences: { ...defaults, ...raw.preferences },
        workBricks: Array.isArray(raw.workBricks) ? raw.workBricks : [],
        exclusions: Array.isArray(raw.exclusions) ? raw.exclusions : [],
      };
      if (this.resolveProjects) {
        // Live membership participates in approval and export, but durable grants
        // keep workspace IDs so newly attached conversations need no reauthorization.
        state[scopedProjects] = new Map(state.sources.filter(source => !source.revokedAt)
          .map(source => [source.id, this.resolveProjects(source)]));
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async transact(change) {
    await mkdir(dirname(this.file), { mode: 0o700, recursive: true });
    const lockPath = `${this.file}.lock`;
    // The lock serializes mutations across DSH processes as well as within one host.
    await acquireLock(lockPath);
    const temporary = `${this.file}.tmp`;
    try {
      await rm(temporary, { force: true });
      const state = await this.state();
      const result = change(state, this.timestamp());
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, this.file);
      return result;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(lockPath, { force: true });
    }
  }

  async setMode(mode) {
    choice(mode, modes, 'Mode');
    return this.transact((state) => {
      state.mode = mode;
      return mode;
    });
  }

  async authorizeSource(input) {
    const id = requiredString(input?.id, 'Source ID', 128);
    const projects = [...new Set(values(input.projects, 'Projects', 100).map(id => requiredString(id, 'Project ID', 128)))];
    if (projects.length === 0) throw new Error('At least one project must be explicitly authorized.');
    return this.transact((state, now) => {
      const previous = state.sources.find((source) => source.id === id);
      const entry = { id, projects, authorizedAt: now };
      if (previous) return Object.assign(previous, { ...entry, revokedAt: undefined });
      state.sources.push(entry);
      return entry;
    });
  }

  async revokeSource(id) {
    return this.transact((state, now) => {
      const source = findRecord(state.sources, id, 'source');
      source.revokedAt ??= now;
      for (const item of state.evidence) {
        if (item.sourceId === id && ['pending', 'approved'].includes(item.status)) {
          review(item, 'revoke', now);
          item.shareable = false;
        }
      }
      for (const item of state.reflections) {
        if (item.sourceId === id && ['pending', 'approved'].includes(item.status)) {
          review(item, 'revoke', now);
        }
      }
      return source;
    });
  }

  async forgetSource(id) {
    return this.transact((state, now) => {
      const source = findRecord(state.sources, id, 'source');
      const forgottenEvidence = new Set(state.evidence.filter((row) => row.sourceId === id).map((row) => row.id));
      const forgottenReflections = new Set(state.reflections
        .filter((row) => row.sourceId === id || row.evidenceIds.some((evidenceId) => forgottenEvidence.has(evidenceId)))
        .map((row) => row.id));
      state.events = state.events.filter((row) => row.sourceId !== id);
      state.evidence = state.evidence.filter((row) => !forgottenEvidence.has(row.id));
      state.reflections = state.reflections.filter((row) => !forgottenReflections.has(row.id));
      const removedResumes = includeDependentResumes(state.resumes, new Set(state.resumes
        .filter(row => resumeDirectlyUsesEvidence(row, evidenceId => forgottenEvidence.has(evidenceId)))
        .map(row => row.id)));
      state.resumes = state.resumes.filter(row => !removedResumes.has(row.id));
      state.suggestions = state.suggestions.filter((row) =>
        !row.reflectionIds.some((reflectionId) => forgottenReflections.has(reflectionId)));
      state.workBricks = (state.workBricks ?? []).filter((brick) => brick?.sourceId !== id);
      state.exclusions = (state.exclusions ?? []).filter((entry) =>
        entry?.sourceId !== id && (!entry?.evidenceId || !forgottenEvidence.has(entry.evidenceId)));
      source.projects = [];
      source.revokedAt ??= now;
      source.forgottenAt = now;
      return source;
    });
  }

  async importLegacyCalibration({ workBricks = [], exclusions = [], exclusionOrigins = {} } = {}) {
    return this.transact((state, now) => {
      if (state.legacyCalibrationMigrated) return { migrated: false };
      const existingBricks = Array.isArray(state.workBricks) ? state.workBricks : [];
      const existingByKey = new Set(existingBricks.map((b) => b?.key).filter(Boolean));
      const importedBricks = [];
      for (const raw of Array.isArray(workBricks) ? workBricks : []) {
        if (!raw || typeof raw !== 'object' || !raw.key || !raw.title || !raw.text || !raw.sourceId || !raw.projectId) continue;
        if (existingByKey.has(raw.key)) continue;
        const occurredAt = (() => {
          try { return dateString(raw.occurredAt); } catch { return ''; }
        })();
        if (!occurredAt) continue;
        const source = state.sources.find((s) => s.id === raw.sourceId);
        if (source?.forgottenAt && occurredAt <= source.forgottenAt) continue;
        existingByKey.add(raw.key);
        importedBricks.push({
          ...raw,
          id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : shortId(raw.sourceId, raw.projectId, raw.key),
          occurredAt,
        });
      }
      state.workBricks = pruneWorkBricks([...existingBricks, ...importedBricks], Date.parse(now))
        .filter((b) => !isBrickPreErasure(state, b));

      const mergedExclusions = [];
      const seen = new Set();
      const pushEntry = (entry) => {
        if (!entry || typeof entry.text !== 'string') return;
        const text = entry.text.trim().slice(0, 80);
        if (!text) return;
        const low = text.toLowerCase();
        if (seen.has(low)) return;
        if (entry.sourceId) {
          const source = state.sources.find((s) => s.id === entry.sourceId);
          if (source?.forgottenAt && (!entry.createdAt || entry.createdAt <= source.forgottenAt)) return;
          if (entry.evidenceId && !state.evidence.some((ev) => ev.id === entry.evidenceId)) return;
        }
        seen.add(low);
        mergedExclusions.push({ ...entry, text });
      };
      for (const existing of state.exclusions ?? []) pushEntry(existing);
      const origins = exclusionOrigins && typeof exclusionOrigins === 'object' && !Array.isArray(exclusionOrigins)
        ? exclusionOrigins
        : {};
      for (const rawRule of Array.isArray(exclusions) ? exclusions : []) {
        const text = typeof rawRule === 'string' ? rawRule.trim() : (typeof rawRule?.text === 'string' ? rawRule.text.trim() : '');
        if (!text) continue;
        const origin = origins[text.toLowerCase()];
        const evidenceRow = origin?.evidenceId ? state.evidence.find((ev) => ev.id === origin.evidenceId) : null;
        if (origin?.sourceId) {
          pushEntry({
            text,
            sourceId: origin.sourceId,
            projectId: origin.projectId || evidenceRow?.projectId || '',
            evidenceId: origin.evidenceId || '',
            createdAt: now,
          });
        } else {
          pushEntry({ text });
        }
      }
      state.exclusions = mergedExclusions.slice(-MAX_EXCLUSION_RULES);
      state.legacyCalibrationMigrated = true;
      return { migrated: true };
    });
  }

  async ingestBricksAndRollup(rawBricks = [], { locale = 'zh' } = {}) {
    const inputList = Array.isArray(rawBricks) ? rawBricks : [];
    return this.transact((state, now) => {
      const nowMs = Date.parse(now);
      if (state.mode === 'off') {
        return { accepted: 0, rolledUp: [], bufferedCount: (state.workBricks ?? []).filter((b) => isBrickActive(state, b, nowMs)).length };
      }
      const existingBricks = (state.workBricks ?? []).filter((b) => !isBrickPreErasure(state, b));
      const seenKeys = new Set(existingBricks.map((b) => b?.key).filter(Boolean));
      const newBricks = [];
      for (const item of inputList) {
        if (!item || typeof item !== 'object') continue;
        const key = optionalString(item.key, 'Brick key', 200);
        const sourceId = optionalString(item.sourceId, 'Brick source ID', 128);
        const projectId = optionalString(item.projectId, 'Brick project ID', 128);
        const title = optionalString(item.title, 'Brick title', 180);
        const text = optionalString(item.text, 'Brick text', 2000);
        if (!key || !sourceId || !projectId || !title || !text) continue;
        if (!isAuthorized(state, sourceId, projectId)) continue;
        let occurredAt;
        try { occurredAt = dateString(item.occurredAt); } catch { continue; }
        const source = state.sources.find((row) => row.id === sourceId);
        if (source?.forgottenAt && occurredAt <= source.forgottenAt) continue;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const id = optionalString(item.id, 'Brick ID', 64) ?? shortId(sourceId, projectId, key);
        newBricks.push({
          id,
          key,
          sourceId,
          projectId,
          sourceRef: optionalString(item.sourceRef, 'Brick source reference', 1600) ?? `${sourceId}:${projectId}:${key}`,
          occurredAt,
          title,
          text,
          role: optionalString(item.role, 'Brick role', 240) ?? '',
          impact: optionalString(item.impact, 'Brick impact', 240) ?? '',
          topic: optionalString(item.topic, 'Brick topic', 64) ?? title.slice(0, 28),
        });
      }

      const merged = pruneWorkBricks([...existingBricks, ...newBricks], nowMs);
      const authorizedForRollup = merged.filter((b) => !b.promotedAt && isAuthorized(state, b.sourceId, b.projectId));
      const { rollups } = rollupWorkBricks(authorizedForRollup, nowMs, locale, {
        makeEventId: (memberKeys) => `rollup:${shortId(memberKeys)}`,
      });
      const knownEvents = new Set(state.events.map((event) => event.key));
      const promotedIds = new Set();
      const rolledUp = [];
      const normalizeRollupTopic = (title = '') => String(title || '').replace(/\s*·\s*(?:阶段里程碑|Milestone)$/u, '').trim().toLowerCase();
      for (const r of rollups) {
        const eventSpec = r.event;
        const key = shortId(eventSpec.sourceId, eventSpec.projectId, eventSpec.id);
        const specEv = eventSpec.evidence?.[0];
        const specTopic = normalizeRollupTopic(specEv?.title);
        const specText = String(specEv?.text || '').trim();
        const legacyReplay = Boolean(specText && specTopic) && state.evidence.some((ev) =>
          ev.sourceId === eventSpec.sourceId
          && ev.projectId === eventSpec.projectId
          && String(ev.eventId || '').startsWith('rollup:')
          && ev.occurredAt === eventSpec.occurredAt
          && normalizeRollupTopic(ev.title) === specTopic
          && String(ev.text || '').trim() === specText);
        if (knownEvents.has(key) || legacyReplay) {
          for (const cid of r.consumedIds) promotedIds.add(cid);
          continue;
        }
        const event = {
          id: eventSpec.id,
          key,
          sourceId: eventSpec.sourceId,
          projectId: eventSpec.projectId,
          sourceRef: eventSpec.sourceRef,
          kind: eventSpec.kind,
          occurredAt: eventSpec.occurredAt,
          recordedAt: now,
        };
        const created = (eventSpec.evidence ?? []).map((entry, index) => trimEvidence(entry, event, index, now));
        state.events.push(event);
        state.evidence.push(...created);
        knownEvents.add(key);
        rolledUp.push(...created);
        for (const cid of r.consumedIds) promotedIds.add(cid);
      }

      state.workBricks = merged.map((b) => (promotedIds.has(b.id) ? { ...b, promotedAt: b.promotedAt || now } : b));
      const bufferedCount = state.workBricks.filter((b) => isBrickActive(state, b, nowMs)).length;
      return { accepted: newBricks.length, rolledUp, bufferedCount };
    });
  }

  async dismissEvidenceTaste(id, rawPattern) {
    return this.transact((state, now) => {
      const evidence = findRecord(state.evidence, id, 'evidence');
      review(evidence, 'reject', now);
      const pattern = String(rawPattern || evidence.title || '').trim().slice(0, 60);
      if (pattern) {
        const low = pattern.toLowerCase();
        const existing = Array.isArray(state.exclusions) ? state.exclusions : [];
        const prior = existing.find((item) => String(item?.text || '').toLowerCase() === low);
        const isExistingManual = Boolean(prior && !prior.sourceId);
        if (!isExistingManual) {
          const entry = {
            text: pattern,
            sourceId: evidence.sourceId,
            projectId: evidence.projectId || '',
            evidenceId: evidence.id,
            createdAt: now,
          };
          const filtered = existing.filter((item) => String(item?.text || '').toLowerCase() !== low);
          state.exclusions = [...filtered, entry].slice(-MAX_EXCLUSION_RULES);
        }
      }
      return { rejected: true, exclusions: activeExclusions(state).map((item) => item.text) };
    });
  }

  async setExclusions(rawRules) {
    const listRules = values(rawRules, 'Exclusions', MAX_EXCLUSION_RULES);
    return this.transact((state) => {
      const existingByLow = new Map(
        (Array.isArray(state.exclusions) ? state.exclusions : [])
          .filter((item) => item && typeof item.text === 'string')
          .map((item) => [item.text.trim().toLowerCase(), item]),
      );
      const next = [];
      const seen = new Set();
      for (const raw of listRules) {
        const text = requiredString(raw, 'Exclusion rule', 80);
        const low = text.toLowerCase();
        if (seen.has(low)) continue;
        seen.add(low);
        const prior = existingByLow.get(low);
        next.push(prior ? { ...prior, text } : { text });
      }
      state.exclusions = next;
      return activeExclusions(state).map((item) => item.text);
    });
  }

  async removeExclusion(rule) {
    const target = requiredString(rule, 'Exclusion rule', 80);
    const low = target.toLowerCase();
    return this.transact((state) => {
      state.exclusions = (Array.isArray(state.exclusions) ? state.exclusions : [])
        .filter((item) => String(item?.text || '').trim().toLowerCase() !== low);
      return activeExclusions(state).map((item) => item.text);
    });
  }

  async setPreferences(patch) {
    const settings = {};
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(patch, key)) continue;
      const value = patch[key];
      if (key === 'timezone') {
        new Intl.DateTimeFormat('en-US', { timeZone: requiredString(value, 'Timezone', 80) });
      } else if (key.endsWith('Hour')) {
        if (!Number.isInteger(value) || value < 0 || value > 23) throw new Error(`${key} must be an integer from 0 to 23.`);
      } else if (typeof value !== 'boolean') {
        throw new Error(`${key} must be a boolean.`);
      }
      settings[key] = value;
    }
    return this.transact((state, now) => {
      Object.assign(state.preferences, settings);
      if (state.mode !== 'off') updateSuggestions(state, now);
      return state.preferences;
    });
  }

  async ingestEvents(input, { explicitManual = false } = {}) {
    const batch = values(input, 'Events', 500);
    return this.transact((state, now) => {
      const result = { accepted: 0, duplicates: 0, unauthorized: 0, disabled: 0, evidence: [] };
      const known = new Set(state.events.map((event) => event.key));
      for (const item of batch) {
        if (state.mode === 'off' && !(explicitManual && item?.sourceId === 'manual')) {
          result.disabled += 1;
          continue;
        }
        const id = requiredString(item.id, 'Event ID', 200);
        const sourceId = requiredString(item.sourceId, 'Event source ID', 128);
        const projectId = requiredString(item.projectId, 'Event project ID', 128);
        if (!isAuthorized(state, sourceId, projectId)) {
          result.unauthorized += 1;
          continue;
        }
        const occurredAt = dateString(item.occurredAt);
        const source = state.sources.find((row) => row.id === sourceId);
        if (source.forgottenAt && occurredAt <= source.forgottenAt) {
          result.unauthorized += 1;
          continue;
        }
        const key = shortId(sourceId, projectId, id);
        if (known.has(key)) {
          result.duplicates += 1;
          continue;
        }
        const sourceRef = optionalString(item.sourceRef, 'Event source reference', 1600) ?? `${sourceId}:${projectId}:${id}`;
        const event = {
          id, key, sourceId, projectId, sourceRef,
          kind: requiredString(item.kind, 'Event kind', 100),
          occurredAt,
          recordedAt: now,
        };
        const evidence = values(item.evidence ?? [], 'Evidence proposals', 30)
          .map((entry, index) => trimEvidence(entry, event, index, now));
        state.events.push(event);
        state.evidence.push(...evidence);
        known.add(key);
        result.accepted += 1;
        result.evidence.push(...evidence);
      }
      return result;
    });
  }

  async reviewEvidence(id, options) {
    if (options.shareable !== undefined && typeof options.shareable !== 'boolean') {
      throw new Error('Evidence shareability must be explicitly true or false.');
    }
    return this.transact((state, now) => {
      const evidence = findRecord(state.evidence, id, 'evidence');
      const alreadyApproved = evidence.status === 'approved';
      const previouslyShareable = evidence.shareable;
      const correctedFields = {};
      if (options.action === 'approve') {
        if (!isAuthorized(state, evidence.sourceId, evidence.projectId)) throw new Error('The evidence source is no longer authorized.');
        // A correction becomes part of the reviewed claim and keeps the original proposal for accountability.
        for (const field of ['title', 'text', 'role', 'impact']) {
          if (options[field] !== undefined) {
            const max = { title: 180, text: 6000, role: 1200, impact: 2000 }[field];
            const corrected = ['title', 'text'].includes(field)
              ? requiredString(options[field], `Evidence ${field}`, max)
              : optionalString(options[field], `Evidence ${field}`, max);
            if (evidence[field] === corrected) continue;
            correctedFields[field] = evidence[field];
            evidence[field] = corrected;
          }
        }
        if (Object.keys(correctedFields).length) {
          evidence.originalProposal = { ...correctedFields, ...evidence.originalProposal };
        }
      }
      if (options.action === 'approve' && alreadyApproved) evidence.reviewedAt = now;
      else review(evidence, options.action, now);
      evidence.shareable = options.action === 'approve' && (options.shareable ?? previouslyShareable);
      if (options.note !== undefined) evidence.reviewNote = optionalString(options.note, 'Review note', 2000);
      if (alreadyApproved && (Object.keys(correctedFields).length || (previouslyShareable && !evidence.shareable))) {
        const invalidated = includeDependentResumes(state.resumes, new Set(state.resumes
          .filter(row => resumeDirectlyUsesEvidence(row, eid => eid === evidence.id))
          .map(row => row.id)));
        for (const resume of state.resumes) {
          if (invalidated.has(resume.id) && ['pending', 'approved'].includes(resume.status)) {
            review(resume, 'revoke', now);
            resume.invalidatedByEvidenceId = evidence.id;
          }
        }
      }
      return evidence;
    });
  }

  async updateEvidence(id, changes = {}) {
    return this.transact((state, now) => {
      const evidence = findRecord(state.evidence, id, 'evidence');
      if (!['pending', 'approved'].includes(evidence.status)) {
        throw new Error('Only active evidence can be edited.');
      }
      const alreadyApproved = evidence.status === 'approved';
      const previouslyShareable = evidence.shareable;
      const correctedFields = {};
      for (const field of ['title', 'text', 'role', 'impact']) {
        if (changes[field] === undefined) continue;
        const max = { title: 180, text: 6000, role: 1200, impact: 2000 }[field];
        const corrected = ['title', 'text'].includes(field)
          ? requiredString(changes[field], `Evidence ${field}`, max)
          : optionalString(changes[field], `Evidence ${field}`, max);
        if ((evidence[field] ?? '') === corrected) continue;
        correctedFields[field] = evidence[field] ?? '';
        evidence[field] = corrected;
      }
      if (Object.keys(correctedFields).length) {
        evidence.originalProposal = { ...correctedFields, ...evidence.originalProposal };
        evidence.updatedAt = now;
      }
      if (typeof changes.shareable === 'boolean') {
        if (changes.shareable && !isAuthorized(state, evidence.sourceId, evidence.projectId)) {
          throw new Error('The evidence source is no longer authorized.');
        }
        evidence.shareable = changes.shareable;
        if (evidence.status === 'pending') {
          evidence.status = 'approved';
          evidence.reviewedAt = now;
        }
      }
      if (alreadyApproved && (Object.keys(correctedFields).length || (previouslyShareable && !evidence.shareable))) {
        const invalidated = includeDependentResumes(state.resumes, new Set(state.resumes
          .filter(row => resumeDirectlyUsesEvidence(row, eid => eid === evidence.id))
          .map(row => row.id)));
        for (const resume of state.resumes) {
          if (invalidated.has(resume.id) && ['pending', 'approved'].includes(resume.status)) {
            review(resume, 'revoke', now);
            resume.invalidatedByEvidenceId = evidence.id;
          }
        }
      }
      return evidence;
    });
  }

  async deleteEvidence(id) {
    return this.transact((state, now) => {
      const index = state.evidence.findIndex(item => item.id === id);
      if (index < 0) throw new Error(`Unknown evidence: ${id}`);
      const [removed] = state.evidence.splice(index, 1);
      const invalidated = includeDependentResumes(state.resumes, new Set(state.resumes
        .filter(row => resumeDirectlyUsesEvidence(row, eid => eid === removed.id))
        .map(row => row.id)));
      for (const resume of state.resumes) {
        if (invalidated.has(resume.id) && ['pending', 'approved'].includes(resume.status)) {
          review(resume, 'revoke', now);
          resume.invalidatedByEvidenceId = removed.id;
        }
      }
      return { deleted: true, id: removed.id };
    });
  }

  async deleteReflection(id) {
    return this.transact((state, now) => {
      const index = state.reflections.findIndex(item => item.id === id);
      if (index < 0) throw new Error(`Unknown reflection: ${id}`);
      const [removed] = state.reflections.splice(index, 1);
      updateSuggestions(state, now);
      return { deleted: true, id: removed.id };
    });
  }

  async recordReflection(input, { actor = 'user', explicitManual = false } = {}) {
    choice(actor, new Set(['user', 'model']), 'Reflection actor');
    const id = requiredString(input.id ?? randomUUID(), 'Reflection ID', 128);
    const dimension = choice(input.dimension, dimensions, 'Reflection dimension');
    const severity = choice(input.severity, severities, 'Reflection severity');
    const text = optionalString(input.text, 'Reflection text', 4000);
    const evidenceIds = uniqueIds(input.evidenceIds ?? [], 'Evidence IDs');
    const sourceId = optionalString(input.sourceId, 'Reflection source ID', 128);
    const projectId = optionalString(input.projectId, 'Reflection project ID', 128);
    const sourceRef = optionalString(input.sourceRef, 'Reflection source reference', 1600);
    const eventKey = optionalString(input.eventKey, 'Reflection event key', 256);
    return this.transact((state, now) => {
      if (!(actor === 'user' && explicitManual)) {
        active(state);
        if (!state.preferences.allowReflections) throw new Error('Career reflections require opt-in.');
      }
      const existing = state.reflections.find((row) => row.id === id);
      if (existing) return existing;
      const hasSourceProvenance = Boolean(sourceId && projectId);
      if (actor === 'model' && evidenceIds.length === 0 && !hasSourceProvenance) {
        throw new Error('Model reflections require evidence references.');
      }
      const occurredAt = input.occurredAt === undefined ? now : dateString(input.occurredAt);
      if (occurredAt > now) throw new Error('A reflection cannot be dated in the future.');
      if (sourceId) {
        if (!projectId || !isAuthorized(state, sourceId, projectId)) {
          throw new Error('Reflection references revoked or unauthorized source.');
        }
        const source = state.sources.find((row) => row.id === sourceId);
        if (source?.forgottenAt && occurredAt <= source.forgottenAt) {
          throw new Error('Reflection references forgotten source period.');
        }
      }
      for (const evidenceId of evidenceIds) {
        const evidence = findRecord(state.evidence, evidenceId, 'evidence');
        if (!['pending', 'approved'].includes(evidence.status) ||
            !isAuthorized(state, evidence.sourceId, evidence.projectId)) {
          throw new Error('Reflection references revoked or invalid evidence.');
        }
      }
      const record = {
        id, dimension, severity, text, evidenceIds, actor, occurredAt, createdAt: now,
        ...(sourceId ? { sourceId, projectId, ...(sourceRef ? { sourceRef } : {}), ...(eventKey ? { eventKey } : {}) } : {}),
        status: actor === 'user' ? 'approved' : 'pending',
      };
      if (actor === 'user') referencedEvidence(state, evidenceIds);
      state.reflections.push(record);
      if (state.mode !== 'off') updateSuggestions(state, now);
      return record;
    });
  }

  async reviewReflection(id, { action }) {
    return this.transact((state, now) => {
      const reflection = findRecord(state.reflections, id, 'reflection');
      if (action === 'approve') {
        active(state);
        if (!state.preferences.allowReflections) throw new Error('Career reflections require opt-in.');
        if (reflection.sourceId && !isAuthorized(state, reflection.sourceId, reflection.projectId)) {
          throw new Error('Reflection references revoked or unauthorized source.');
        }
        referencedEvidence(state, reflection.evidenceIds);
      }
      review(reflection, action, now);
      updateSuggestions(state, now);
      return reflection;
    });
  }

  async listNotifications() {
    const state = await this.state();
    const now = this.timestamp();
    if (state.mode === 'off' || !state.preferences.allowReflections ||
        !state.preferences.notificationsEnabled || !duringNotificationHours(state.preferences, now)) return [];
    return state.suggestions.filter((entry) => currentSuggestion(state, entry, now));
  }

  async reviewSuggestion(id, { action }) {
    if (!['acknowledge', 'dismiss'].includes(action)) throw new Error('Action must be acknowledge or dismiss.');
    return this.transact((state, now) => {
      const entry = findRecord(state.suggestions, id, 'suggestion');
      if (entry.status === 'pending') {
        entry.status = action === 'dismiss' ? 'dismissed' : 'acknowledged';
        entry.reviewedAt = now;
      }
      return entry;
    });
  }

  async importResume(input) {
    const title = requiredString(input.title, 'Resume title', 180);
    const text = requiredString(input.text, 'Resume text', 100_000);
    return this.transact((state, now) => {
      const id = randomUUID();
      const entry = {
        id, trackId: id, trackTitle: title, title, text, origin: 'user-import', kind: 'import',
        status: 'pending', createdAt: now,
      };
      state.resumes.push(entry);
      return entry;
    });
  }

  async proposeResume(input) {
    const title = requiredString(input.title, 'Resume title', 180);
    const baseId = optionalString(input.baseId, 'Base resume ID', 128);
    const mergedText = optionalString(input.mergedText, 'Merged resume text', 100_000);
    const summary = optionalString(input.summary, 'Merge summary', 1200);
    const mergeMode = input.mergeMode === 'llm' || input.mergeMode === 'structural' ? input.mergeMode : undefined;
    const placements = Array.isArray(input.placements)
      ? input.placements.slice(0, 40).flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const section = optionalString(row.section, 'Placement section', 160);
        const bullet = optionalString(row.bullet, 'Placement bullet', 1200);
        const reason = optionalString(row.reason, 'Placement reason', 240);
        const evidenceId = optionalString(row.evidenceId, 'Placement evidence ID', 128);
        if (!section && !bullet) return [];
        return [{ ...(evidenceId && { evidenceId }), ...(section && { section }), ...(bullet && { bullet }), ...(reason && { reason }) }];
      })
      : [];
    const items = values(input.items, 'Resume items', 100).map((item) => ({
      text: requiredString(item.text, 'Resume item', 6000),
      evidenceIds: uniqueIds(item.evidenceIds, 'Resume evidence IDs'),
    }));
    if (items.length === 0 || items.some((item) => item.evidenceIds.length === 0)) {
      throw new Error('Every resume claim needs at least one approved, externally shareable evidence reference.');
    }
    return this.transact((state, now) => {
      const included = resumeEvidenceIds(state.resumes, baseId);
      if (items.some(item => item.evidenceIds.some(id => included.has(id)))) {
        throw new Error('This evidence already appears in the base resume.');
      }
      const previous = state.resumes.findLast(row => row.kind === 'generated' && row.status === 'pending'
        && row.baseId === baseId && row.title === title && JSON.stringify(row.items) === JSON.stringify(items));
      if (previous) {
        resumeMarkdown(state, previous);
        return previous;
      }
      const id = randomUUID();
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const base = baseId ? byId.get(baseId) : null;
      const trackId = base ? resolveTrackId(base, byId) : id;
      const trackTitle = base?.trackTitle || (!base ? title : undefined);
      const entry = {
        id, trackId, ...(trackTitle && { trackTitle }), title, items, baseId,
        ...(base?.appearance && { appearance: structuredClone(base.appearance) }),
        ...(mergedText && { mergedText }),
        ...(summary && { summary }),
        ...(placements.length && { placements }),
        ...(mergeMode && { mergeMode }),
        origin: 'evidence', kind: 'generated', status: 'pending', createdAt: now,
      };
      resumeMarkdown(state, entry);
      state.resumes.push(entry);
      return entry;
    });
  }

  async proposeTailoredResume(input) {
    const { baseId } = input;
    const title = requiredString(input.title, 'Resume title', 180);
    requiredString(baseId, 'Base resume ID', 128);
    const opportunityId = optionalString(input.opportunityId, 'Opportunity ID', 255);
    const gaps = optionalString(input.gaps, 'Role gaps', 3500);
    const items = values(input.lines, 'Tailored resume lines', 100).map(item => {
      requiredString(item?.source, 'Original line', 6200);
      const reason = optionalString(item?.reason, 'Tailor reason', 160);
      return { source: item.source, text: adaptedLine(item.text), ...(reason && { reason }) };
    });
    if (!items.length) throw new Error('A tailored resume needs at least one change.');
    return this.transact((state, now) => {
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const base = byId.get(baseId);
      const sourceTrackId = base ? resolveTrackId(base, byId) : undefined;
      const entry = {
        id: randomUUID(), parentId: baseId, baseId, ...(sourceTrackId && { sourceTrackId }),
        ...(base?.appearance && { appearance: structuredClone(base.appearance) }),
        title, opportunityId, gaps, items,
        origin: 'tailored', kind: 'tailored', status: 'pending', createdAt: now,
      };
      const text = resumeMarkdown(state, entry);
      state.resumes.push(entry);
      return { ...entry, text };
    });
  }

  async proposeOptimizedResume({ baseId, items, summary, expectedText }) {
    requiredString(baseId, 'Base resume ID', 128);
    const edits = values(items, 'Resume optimization edits', 20).map(item => {
      if (!Number.isSafeInteger(item?.line) || item.line < 0 || typeof item.promote !== 'boolean') {
        throw new Error('优化建议未关联到有效的原文位置。');
      }
      const text = requiredString(item.text, 'Updated line', 6000);
      requiredString(item.source, 'Original line', 10_000);
      const reason = optionalString(item.reason, 'Optimization reason', 160);
      return { line: item.line, source: item.source, text, promote: item.promote, ...(reason && { reason }) };
    });
    if (!edits.length) throw new Error('简历优化至少需要一处改动。');
    const note = optionalString(summary, 'Optimization summary', 1200);
    return this.transact((state, now) => {
      const base = findRecord(state.resumes, baseId, 'base resume');
      if (!['pending', 'approved'].includes(base.status) || resumeMarkdown(state, base) !== expectedText) {
        throw new Error('原简历已有变化。请在选定版本上重试。');
      }
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const isGeneral = base.kind !== 'tailored' ? (base.general ?? !base.opportunityId) : base.general === true;
      const trackId = !base.opportunityId ? resolveTrackId(base, byId) : undefined;
      const sourceTrackId = base.opportunityId ? (base.sourceTrackId || resolveTrackId(base, byId)) : undefined;
      const entry = {
        id: randomUUID(), parentId: base.id, baseId: base.id,
        ...(trackId && { trackId }),
        ...(base.trackTitle && { trackTitle: base.trackTitle }),
        ...(sourceTrackId && { sourceTrackId }),
        ...(base.appearance && { appearance: structuredClone(base.appearance) }),
        title: '对话优化稿',
        opportunityId: base.opportunityId, origin: 'resume-conversation', variant: 'conversation',
        kind: 'tailored', status: 'pending', createdAt: now, items: edits, summary: note,
        general: isGeneral,
        gaps: base.gaps,
      };
      const text = resumeMarkdown(state, entry);
      if (text === expectedText) throw new Error('优化建议没有改变原简历。');
      state.resumes.push(entry);
      return { ...entry, text };
    });
  }

  async reviseResume(id, input = {}) {
    return this.transact((state, now) => {
      const version = findRecord(state.resumes, id, 'resume');
      if (version.status === 'revoked') throw new Error('A revoked resume cannot be edited.');
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const requestedOppId = typeof input.opportunityId === 'string' && input.opportunityId.trim()
        ? optionalString(input.opportunityId, 'Opportunity id', 180)
        : '';
      const targetOppId = requestedOppId || version.opportunityId || '';
      const forkingToJob = Boolean(requestedOppId && requestedOppId !== version.opportunityId);
      const isJobSpecific = Boolean(
        targetOppId
        || version.general === false
        || (version.kind === 'tailored' && version.general !== true),
      );
      const trackId = !isJobSpecific ? resolveTrackId(version, byId) : undefined;
      const sourceTrackId = isJobSpecific ? (version.sourceTrackId || resolveTrackId(version, byId)) : undefined;
      if (version.kind === 'import' || typeof input.text === 'string') {
        const text = requiredString(input.text, 'Resume text', 100_000);
        const nextTitle = typeof input.title === 'string' && input.title.trim()
          ? optionalString(input.title, 'Resume title', 180)
          : version.title;
        let previousText = '';
        try { previousText = resumeMarkdown(state, version); } catch { previousText = String(version.text || ''); }
        const explicitEvidenceIds = Array.isArray(input.evidenceIds)
          ? [...new Set(input.evidenceIds.filter(eid => typeof eid === 'string' && eid.trim()).map(eid => eid.trim()))]
          : [];
        const detectedEvidenceIds = detectAbsorbedEvidenceIds(state.evidence, previousText, text);
        const combinedEvidenceIds = [...new Set([
          ...resumeEvidenceIds(state.resumes, version.id),
          ...explicitEvidenceIds,
          ...detectedEvidenceIds,
        ])];
        const nextAppearance = sanitizeAppearance(input.appearance) ?? (version.appearance ? structuredClone(version.appearance) : undefined);
        if (!forkingToJob && input.inPlace === true && version.status === 'pending' && version.autoSaved === true) {
          version.text = text;
          version.updatedAt = now;
          if (combinedEvidenceIds.length) version.evidenceIds = combinedEvidenceIds;
          if (nextTitle) version.title = nextTitle;
          if (input.variant === 'conversation') version.variant = 'conversation';
          if (nextAppearance) version.appearance = nextAppearance;
          resumeMarkdown(state, version);
          return version;
        }
        const autoMeta = {
          ...(input.autoSaved === true && { autoSaved: true, updatedAt: now }),
          ...(input.variant === 'conversation' && { variant: 'conversation' }),
          ...(nextAppearance && { appearance: nextAppearance }),
        };
        if (version.kind === 'import' && !forkingToJob) {
          const draft = {
            id: randomUUID(), parentId: version.id,
            ...(trackId && { trackId }),
            ...(version.trackTitle && { trackTitle: version.trackTitle }),
            ...(combinedEvidenceIds.length && { evidenceIds: combinedEvidenceIds }),
            title: nextTitle, origin: version.origin,
            kind: 'import', status: 'pending', createdAt: now, text, ...autoMeta,
          };
          resumeMarkdown(state, draft);
          state.resumes.push(draft);
          return draft;
        }
        const draft = {
          id: randomUUID(), parentId: version.id, baseId: version.id,
          ...(trackId && { trackId }),
          ...(!forkingToJob && version.trackTitle && { trackTitle: version.trackTitle }),
          ...(sourceTrackId && { sourceTrackId }),
          title: nextTitle,
          origin: version.origin, kind: 'revised', status: 'pending', createdAt: now, text,
          ...(combinedEvidenceIds.length && { evidenceIds: combinedEvidenceIds }),
          ...(targetOppId && { opportunityId: targetOppId }),
          general: !isJobSpecific,
          ...(version.gaps && { gaps: version.gaps }),
          ...autoMeta,
        };
        resumeMarkdown(state, draft);
        state.resumes.push(draft);
        return draft;
      }
      const draft = {
        id: randomUUID(), parentId: version.id,
        ...(trackId && { trackId }),
        ...(version.trackTitle && { trackTitle: version.trackTitle }),
        ...(sourceTrackId && { sourceTrackId }),
        title: version.title, origin: version.origin,
        kind: version.kind, status: 'pending', createdAt: now,
      };
      const items = values(input.items, 'Resume items', 100);
      if (items.length !== version.items.length) throw new Error('Edit the wording of the existing evidence entries.');
      draft.baseId = version.baseId;
      if (version.kind === 'tailored') {
        draft.opportunityId = version.opportunityId;
        draft.gaps = version.gaps;
        draft.variant = version.variant;
        draft.summary = version.summary;
        draft.general = version.general;
      }
      draft.items = version.items.map((item, index) => {
        const wording = typeof items[index] === 'string' ? items[index] : items[index]?.text;
        if (version.variant === 'conversation') return { ...item, text: requiredString(wording, 'Resume item', 6000) };
        if (version.kind === 'tailored') return { ...item, source: item.source, text: adaptedLine(wording) };
        return { text: requiredString(wording, 'Resume item', 6000), evidenceIds: [...item.evidenceIds] };
      });
      const text = resumeMarkdown(state, draft);
      state.resumes.push(draft);
      return draft.kind === 'tailored' ? { ...draft, text } : draft;
    });
  }

  async reviewResume(id, { action, selected }) {
    return this.transact((state, now) => {
      const resume = findRecord(state.resumes, id, 'resume');
      if (selected !== undefined) {
        if (action !== 'approve' || resume.kind !== 'tailored' || resume.status !== 'pending'
          || !Array.isArray(selected) || !selected.length || selected.length > resume.items.length
          || new Set(selected).size !== selected.length
          || selected.some(index => !Number.isInteger(index) || index < 0 || index >= resume.items.length)) {
          throw new Error('请从待确认的改稿中选择有效改动。');
        }
        if (selected.length < resume.items.length) {
          const indices = [...selected].sort((a, b) => a - b);
          const selection = indices.join(',');
          const existing = state.resumes.find(item => item.parentId === id && item.reviewSelection === selection && item.status === 'approved');
          if (existing) {
            resumeMarkdown(state, existing);
            return existing;
          }
          const accepted = {
            ...resume, id: randomUUID(), parentId: id,
            title: resume.variant === 'conversation' ? '已选改动' : `${resume.title} · 已选改动`.slice(0, 170),
            summary: undefined,
            items: indices.map(index => resume.items[index]), reviewSelection: selection, createdAt: now,
          };
          delete accepted.autoSaved;
          resumeMarkdown(state, accepted);
          review(accepted, 'approve', now);
          state.resumes.push(accepted);
          return accepted;
        }
      }
      if (action === 'approve') {
        resumeMarkdown(state, resume);
        delete resume.autoSaved;
      }
      review(resume, action, now);
      if (action === 'revoke') {
        const removed = includeDependentResumes(state.resumes, new Set([id]));
        for (const item of state.resumes) {
          if (item.id !== id && removed.has(item.id) && ['pending', 'approved'].includes(item.status)) review(item, 'revoke', now);
        }
      }
      return resume;
    });
  }

  async renameResumeTrack(id, rawTitle) {
    const title = requiredString(rawTitle, 'Resume title', 180);
    return this.transact((state) => {
      const target = findRecord(state.resumes, id, 'resume');
      if (target.opportunityId) {
        for (const row of state.resumes) {
          if (row.opportunityId === target.opportunityId) {
            row.trackTitle = title;
          }
        }
        target.title = title;
        return { id: target.id, title };
      }
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const trackId = resolveTrackId(target, byId);
      for (const row of state.resumes) {
        if (!row.opportunityId && resolveTrackId(row, byId) === trackId) {
          row.trackId = trackId;
          row.trackTitle = title;
        }
      }
      target.title = title;
      return { id: target.id, trackId, title };
    });
  }

  async setDefaultMasterTrack(trackId) {
    const clean = requiredString(trackId, 'Master track ID', 128);
    return this.transact((state) => {
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const exists = state.resumes.some(r =>
        ['pending', 'approved'].includes(r.status) && !r.opportunityId && resolveTrackId(r, byId) === clean,
      );
      if (!exists) throw new Error('找不到对应的主干简历。');
      state.defaultMasterTrackId = clean;
      return { defaultMasterTrackId: clean };
    });
  }

  async branchMasterResume(id, rawTitle) {
    const title = requiredString(rawTitle, 'Resume title', 180);
    return this.transact((state, now) => {
      const source = findRecord(state.resumes, id, 'resume');
      if (!['pending', 'approved'].includes(source.status)) throw new Error('只能基于有效简历创建新主干。');
      const text = resumeMarkdown(state, source);
      const evidenceIds = [...resumeEvidenceIds(state.resumes, source.id)];
      const newId = randomUUID();
      const entry = {
        id: newId,
        trackId: newId,
        trackTitle: title,
        branchedFromId: source.id,
        ...(evidenceIds.length && { evidenceIds }),
        ...(source.appearance && { appearance: structuredClone(source.appearance) }),
        title,
        text,
        origin: 'user-import',
        kind: 'import',
        status: source.status === 'approved' ? 'approved' : 'pending',
        createdAt: now,
        ...(source.status === 'approved' && { reviewedAt: now }),
      };
      state.resumes.push(entry);
      return entry;
    });
  }

  async archiveResume({ id, scope = 'version' }) {
    const cleanId = requiredString(id, 'Resume ID', 128);
    const mode = ['version', 'track', 'older'].includes(scope) ? scope : 'version';
    return this.transact((state, now) => {
      const target = findRecord(state.resumes, cleanId, 'resume');
      if (!['pending', 'approved'].includes(target.status)) throw new Error('该简历版本已失效，无法归档。');
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const activeAll = state.resumes.filter(r => !r.archivedAt && ['pending', 'approved'].includes(r.status));
      const isBranch = Boolean(target.opportunityId || target.general === false || (target.kind === 'tailored' && target.general !== true));

      let targets = [];
      if (mode === 'version') {
        targets = [target];
      } else {
        const sameGroup = activeAll.filter(r => {
          const rBranch = Boolean(r.opportunityId || r.general === false || (r.kind === 'tailored' && r.general !== true));
          if (isBranch) {
            if (!rBranch) return false;
            return (target.opportunityId && r.opportunityId === target.opportunityId) || r.id === target.id;
          }
          if (rBranch) return false;
          return resolveTrackId(r, byId) === resolveTrackId(target, byId);
        });
        if (mode === 'track') {
          targets = sameGroup;
        } else {
          // mode === 'older': keep newest revision active (materialize standalone text first), archive all older ones
          const sorted = sameGroup.slice().sort((a, b) =>
            String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
            || String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')),
          );
          const keeper = sorted.at(-1);
          if (keeper) {
            const inheritedEvidenceIds = [...resumeEvidenceIds(state.resumes, keeper.id)];
            if (inheritedEvidenceIds.length) keeper.evidenceIds = inheritedEvidenceIds;
            if (!keeper.text) {
              keeper.text = resumeMarkdown(state, keeper);
            }
          }
          targets = sorted.slice(0, -1);
        }
      }

      if (!targets.length) return { archivedIds: [], defaultMasterTrackId: state.defaultMasterTrackId || '' };
      const targetIds = new Set(targets.map(r => r.id));

      // Guard: always preserve at least 1 active master resume so the user never ends up with an empty workspace
      const remainingMasters = activeAll.filter(r => {
        if (targetIds.has(r.id)) return false;
        const rBranch = Boolean(r.opportunityId || r.general === false || (r.kind === 'tailored' && r.general !== true));
        return !rBranch;
      });
      if (!isBranch && remainingMasters.length === 0) {
        throw new Error('至少需要保留 1 份活跃的主干母版，无法全部归档。');
      }

      for (const row of targets) {
        row.archivedAt = now;
      }

      // If default master track was archived, promote the newest remaining active master track automatically
      const activeMasterTrackIds = new Set(remainingMasters.map(r => resolveTrackId(r, byId)));
      if (state.defaultMasterTrackId && !activeMasterTrackIds.has(state.defaultMasterTrackId)) {
        const newestMaster = remainingMasters.slice().sort((a, b) =>
          String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')),
        )[0];
        state.defaultMasterTrackId = newestMaster ? resolveTrackId(newestMaster, byId) : '';
      }

      return { archivedIds: [...targetIds], defaultMasterTrackId: state.defaultMasterTrackId || '' };
    });
  }

  async restoreResume({ id, scope = 'version' }) {
    const cleanId = requiredString(id, 'Resume ID', 128);
    const mode = ['version', 'track'].includes(scope) ? scope : 'version';
    return this.transact((state) => {
      const target = findRecord(state.resumes, cleanId, 'resume');
      if (!['pending', 'approved'].includes(target.status)) throw new Error('该简历版本已撤销或失效，无法恢复。');
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const isBranch = Boolean(target.opportunityId || target.general === false || (target.kind === 'tailored' && target.general !== true));
      let targets = [target];
      if (mode === 'track') {
        targets = state.resumes.filter(r => {
          if (!r.archivedAt || !['pending', 'approved'].includes(r.status)) return false;
          const rBranch = Boolean(r.opportunityId || r.general === false || (r.kind === 'tailored' && r.general !== true));
          if (isBranch) return rBranch && ((target.opportunityId && r.opportunityId === target.opportunityId) || r.id === target.id);
          return !rBranch && resolveTrackId(r, byId) === resolveTrackId(target, byId);
        });
      }
      const restoredIds = [];
      for (const row of targets) {
        if (row.archivedAt) {
          // Verify evidence provenance is still valid before restoring
          resumeMarkdown(state, row);
          delete row.archivedAt;
          restoredIds.push(row.id);
        }
      }
      return { restoredIds };
    });
  }

  async deleteArchivedResume(id) {
    const cleanId = requiredString(id, 'Resume ID', 128);
    return this.transact((state) => {
      const idx = state.resumes.findIndex(r => r.id === cleanId);
      if (idx < 0) throw new Error('找不到要移除的简历版本。');
      const target = state.resumes[idx];
      if (!target.archivedAt && target.status !== 'pending') {
        throw new Error('请先归档该已定稿版本，再执行永久移除。');
      }
      // Materialize standalone text AND preserve full inherited evidence provenance on any remaining child
      // referencing target before severing parent links, so forgetSource / revocation always tracks descendants.
      for (const row of state.resumes) {
        if (row.id === cleanId) continue;
        if (row.baseId === cleanId || row.parentId === cleanId || row.branchedFromId === cleanId) {
          const inheritedEvidenceIds = [...resumeEvidenceIds(state.resumes, row.id)];
          if (inheritedEvidenceIds.length) {
            row.evidenceIds = inheritedEvidenceIds;
          }
          if (['pending', 'approved'].includes(row.status) && (!row.text || row.kind === 'tailored' || row.kind === 'generated')) {
            try {
              const materialized = resumeMarkdown(state, row);
              row.text = materialized;
              if (row.kind === 'generated') row.mergedText = materialized;
            } catch {}
          }
          if (row.baseId === cleanId) delete row.baseId;
          if (row.parentId === cleanId) delete row.parentId;
          if (row.branchedFromId === cleanId) delete row.branchedFromId;
        }
      }
      state.resumes.splice(idx, 1);
      return { deletedId: cleanId };
    });
  }

  async rebaseTailoredResume({ branchId, newBaseId, text, summary, placements }) {
    const cleanBranchId = requiredString(branchId, 'Branch resume ID', 128);
    const cleanBaseId = requiredString(newBaseId, 'Master base resume ID', 128);
    const cleanText = requiredString(text, 'Rebased resume text', 100_000);
    const cleanSummary = optionalString(summary, 'Rebase summary', 1200);
    const cleanPlacements = Array.isArray(placements)
      ? placements.slice(0, 40).flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const section = optionalString(row.section, 'Placement section', 160);
        const bullet = optionalString(row.bullet, 'Placement bullet', 1200);
        const reason = optionalString(row.reason, 'Placement reason', 240);
        if (!section && !bullet) return [];
        return [{ ...(section && { section }), ...(bullet && { bullet }), ...(reason && { reason }) }];
      })
      : [];
    return this.transact((state, now) => {
      const branch = findRecord(state.resumes, cleanBranchId, 'branch resume');
      if (!['pending', 'approved'].includes(branch.status)) throw new Error('该岗位定向简历已失效。');
      const isBranch = Boolean(branch.opportunityId || branch.general === false || (branch.kind === 'tailored' && branch.general !== true));
      if (!isBranch) throw new Error('只能对岗位定向分支执行主干同步。');
      const newBase = findRecord(state.resumes, cleanBaseId, 'master base resume');
      if (newBase.status !== 'approved' || newBase.opportunityId || newBase.general === false) {
        throw new Error('请先将主干母版定稿后再同步。');
      }
      const byId = new Map(state.resumes.map(r => [r.id, r]));
      const sourceTrackId = resolveTrackId(newBase, byId);
      const evidenceIds = [...new Set([
        ...resumeEvidenceIds(state.resumes, branch.id),
        ...resumeEvidenceIds(state.resumes, newBase.id),
      ])];
      const draft = {
        id: randomUUID(),
        parentId: branch.id,
        baseId: newBase.id,
        sourceTrackId,
        title: branch.title,
        ...(branch.opportunityId && { opportunityId: branch.opportunityId }),
        ...(branch.gaps && { gaps: branch.gaps }),
        ...((branch.appearance || newBase.appearance) && { appearance: structuredClone(branch.appearance || newBase.appearance) }),
        origin: 'rebase',
        kind: 'revised',
        general: false,
        status: 'pending',
        createdAt: now,
        text: `${cleanText.trimEnd()}\n`,
        ...(evidenceIds.length && { evidenceIds }),
        ...(cleanSummary && { summary: cleanSummary }),
        ...(cleanPlacements.length && { placements: cleanPlacements }),
      };
      resumeMarkdown(state, draft);
      state.resumes.push(draft);
      return draft;
    });
  }

  async updateResumeAppearance(id, input = {}) {
    const cleanId = requiredString(id, 'Resume ID', 128);
    const next = sanitizeAppearance(input);
    return this.transact((state) => {
      const target = findRecord(state.resumes, cleanId, 'resume');
      if (!['pending', 'approved'].includes(target.status)) {
        throw new Error('Cannot update appearance on an inactive resume version.');
      }
      if (!next) {
        delete target.appearance;
      } else {
        target.appearance = {
          ...(target.appearance || {}),
          ...(next.template ? { template: next.template } : {}),
          ...(Object.hasOwn(input ?? {}, 'style')
            ? (next.style ? { style: next.style } : { style: {} })
            : {}),
        };
        if (target.appearance.style && !Object.keys(target.appearance.style).length) {
          delete target.appearance.style;
        }
      }
      return { id: target.id, appearance: target.appearance ?? null };
    });
  }

  async previewResume(id) {
    const state = await this.state();
    const resume = findRecord(state.resumes, id, 'resume');
    if (!['pending', 'approved'].includes(resume.status)) throw new Error('This resume version cannot be previewed.');
    return resumeMarkdown(state, resume);
  }

  async exportResume(id) {
    const state = await this.state();
    const resume = findRecord(state.resumes, id, 'resume');
    if (resume.status !== 'approved') throw new Error('Only a human-approved resume version can be exported.');
    return resumeMarkdown(state, resume);
  }

  async summary() {
    const state = await this.state();
    const now = this.timestamp();
    const redactRevised = row => {
      if (row.kind === 'revised' || (row.kind === 'import' && Array.isArray(row.evidenceIds) && row.evidenceIds.length)) {
        const { text: _hidden, ...safe } = row;
        return safe;
      }
      if (row.kind === 'generated') {
        const { mergedText: _hiddenMerged, placements: _hiddenPlacements, summary: _hiddenSummary, ...safe } = row;
        return safe;
      }
      return row;
    };
    return {
      mode: state.mode,
      defaultMasterTrackId: state.defaultMasterTrackId ?? '',
      sources: state.sources,
      preferences: state.preferences,
      evidence: state.evidence,
      reflections: state.reflections,
      resumes: state.resumes.map(row => {
        if (!['pending', 'approved'].includes(row.status)) return redactRevised(row);
        const evidenceIds = [...resumeEvidenceIds(state.resumes, row.id)];
        const evidenceCount = evidenceIds.length;
        if (row.kind === 'import' && !evidenceCount) return { ...row, evidenceCount, evidenceIds };
        try { return { ...row, text: resumeMarkdown(state, row), evidenceCount, evidenceIds }; }
        catch { return { ...redactRevised(row), status: 'revoked', evidenceCount, evidenceIds }; }
      }),
      suggestions: state.suggestions.map((entry) => entry.status === 'pending' &&
        !currentSuggestion(state, entry, now) ? { ...entry, status: 'expired' } : entry),
      notifications: (state.mode === 'off' || !state.preferences.allowReflections
        || !state.preferences.notificationsEnabled || !duringNotificationHours(state.preferences, now))
        ? []
        : state.suggestions.filter((entry) => currentSuggestion(state, entry, now)),
      workBricks: (state.workBricks ?? []).filter((brick) => isBrickActive(state, brick, Date.parse(now))),
      exclusions: activeExclusions(state).map((entry) => entry.text),
    };
  }
}
