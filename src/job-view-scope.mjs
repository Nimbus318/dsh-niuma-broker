import { companyBoardChannels, companyHiringBoards, findCompanyBoard, hiringScopesFromText, namedCompanyRequests } from './company-boards.mjs';

const keyOf = board => board.provider + ':' + board.slug.toLowerCase();

export const HIRING_SCOPES = new Set(['', 'experienced', 'campus']);

export function normalizeHiringScope(value) {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return HIRING_SCOPES.has(clean) ? clean : '';
}

export function resolveDefaultHiringScope(config = {}) {
  const explicit = normalizeHiringScope(config?.hiringScope);
  if (explicit) return explicit;
  const goalScopes = hiringScopesFromText(config?.goal || '');
  if (goalScopes.includes('campus') && !goalScopes.includes('experienced')) return 'campus';
  if (goalScopes.includes('experienced')) return 'experienced';
  const scopes = new Set();
  for (const board of Array.isArray(config?.boards) ? config.boards : []) {
    const scope = findCompanyBoard(board.provider, board.slug)?.hiringScope;
    if (scope === 'experienced' || scope === 'campus') scopes.add(scope);
  }
  if (scopes.has('campus') && !scopes.has('experienced')) return 'campus';
  return 'experienced';
}

export function pickChannelForScope(board, scope) {
  const channels = companyBoardChannels(board);
  if (scope === 'campus') return channels.find(c => c.hiringScope === 'campus') || null;
  return channels.find(c => c.hiringScope === 'experienced') || channels.find(c => c.hiringScope === 'all') || channels[0] || null;
}

export function migrateBoardsToHiringScope(boards = [], targetScope) {
  const list = Array.isArray(boards) ? boards : [];
  if (targetScope !== 'experienced' && targetScope !== 'campus') {
    return { nextBoards: list, migratedCount: 0, unavailable: [] };
  }
  const deduped = new Map();
  let migratedCount = 0;
  const unavailable = [];
  for (const board of list) {
    const preset = findCompanyBoard(board.provider, board.slug);
    if (!preset?.hiringGroup || preset.hiringScope === targetScope) {
      deduped.set(keyOf(board), board);
      continue;
    }
    const target = companyHiringBoards(preset, [targetScope])[0] || null;
    if (target) {
      const next = {
        provider: target.provider,
        slug: target.slug,
        company: target.company,
        ...(target.domain ? { domain: target.domain } : {}),
      };
      deduped.set(keyOf(next), next);
      migratedCount += 1;
    } else {
      deduped.set(keyOf(board), board);
      unavailable.push({ company: preset.company, companyEn: preset.companyEn || preset.company });
    }
  }
  return { nextBoards: [...deduped.values()], migratedCount, unavailable };
}

export function needsChannelDisambiguation(boardOrSourceId, { userScope = 'experienced', boards = [] } = {}) {
  let preset = null;
  if (typeof boardOrSourceId === 'string') {
    const [provider, slug] = boardOrSourceId.split(':');
    preset = findCompanyBoard(provider, slug);
  } else if (boardOrSourceId && typeof boardOrSourceId === 'object') {
    preset = findCompanyBoard(boardOrSourceId.provider, boardOrSourceId.slug) || boardOrSourceId;
  }
  if (!preset?.hiringScope) return false;
  const boardList = Array.isArray(boards) ? boards : [];
  if (preset.hiringGroup) {
    let groupCount = 0;
    const seen = new Set();
    for (const item of boardList) {
      const resolved = findCompanyBoard(item.provider, item.slug);
      if (resolved?.hiringGroup === preset.hiringGroup) {
        const id = keyOf(resolved);
        if (!seen.has(id)) {
          seen.add(id);
          groupCount += 1;
        }
      }
    }
    if (groupCount > 1) return true;
  }
  if (userScope === 'campus') return preset.hiringScope === 'experienced' || preset.hiringScope === 'all';
  return preset.hiringScope === 'campus';
}

export function matchesJobFilter(job, filter) {
  if (!filter) return true;
  if (Array.isArray(filter.sourceIds)) return filter.sourceIds.includes(String(job.sourceId || '').toLowerCase());
  return Boolean(filter.company && String(job.company || '').toLowerCase() === filter.company.toLowerCase());
}

export function planJobSources(data) {
  const groups = new Set(data?.hiringTargets || []);
  return (data?.boards || []).filter(b => groups.has(findCompanyBoard(b.provider, b.slug)?.hiringGroup)).map(keyOf);
}

export function reconcileJobSources(current, boards) {
  const active = new Set(boards.map(keyOf));
  const ids = new Set();
  for (const id of current) {
    if (active.has(id)) { ids.add(id); continue; }
    const group = findCompanyBoard(...id.split(':'))?.hiringGroup;
    if (group) for (const board of boards) {
      if (findCompanyBoard(board.provider, board.slug)?.hiringGroup === group) ids.add(keyOf(board));
    }
  }
  return [...ids];
}

// Explicitly selected jobs and requests about prior applications are handled separately from discovery.
export function intakeSearchSources(text, boards, viewSourceIds = []) {
  if (/已投|投(?:递)?过|投(?:递)?了|(?:历史|以往|以前|之前)(?:的)?(?:岗位|职位|申请|记录|面试|投递)|已申请|申请过|面试记录|投递进度|申请进度|跟踪记录|previous(?:ly)? (?:applied|tracked|saved|applications?)|application history|already applied|applied to|applications? (?:status|progress)|tracked jobs/i.test(text)) return null;
  const scopes = hiringScopesFromText(text);
  const discovery = /(?:找|搜索|筛选|匹配|推荐|在招|看看|查看).{0,20}(?:岗位|职位|机会)|(?:岗位|职位).{0,8}(?:匹配|推荐)|(?:find|search|recommend|match|show|open|available).{0,30}(?:jobs?|roles?|positions?|openings?|opportunities)/iu.test(text);
  const active = new Set(boards.map(keyOf));
  if (scopes.length || discovery) {
    const named = namedCompanyRequests(text);
    if (named.length) {
      const sources = named.flatMap(({board, scopes: requested}) => requested.length ? companyHiringBoards(board, requested) : companyBoardChannels(board));
      return new Set(sources.map(keyOf).filter(id => active.has(id)));
    }
    if (scopes.length) return new Set(boards.filter(board => scopes.includes(findCompanyBoard(board.provider, board.slug)?.hiringScope)).map(keyOf));
  }
  if (Array.isArray(viewSourceIds) && viewSourceIds.length) return new Set(viewSourceIds.filter(id => active.has(id)));
  return discovery && active.size ? active : null;
}
