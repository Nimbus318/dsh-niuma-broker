import test from 'node:test'
import { recommendBoards } from '../src/board-recommendations.mjs'
import assert from 'node:assert/strict'
import { CURATED_BOARDS, CURATED_COMPANIES, MOKA_PROJECTS, companyBoardChannels, mergeSearchBoards, resolveNamedHiringBoard, boardPosition, boardSearchText, findCompanyBoard, findNamedCompanyBoards, isValidBoardSlug, parseBoardInput } from '../src/company-boards.mjs'

const added = [
  ['feishu', 'infinigence__infinigence', 'Infinigence AI'],
  ['feishu', 'modelbest__career', '面壁智能'],
  ['feishu', 'aisphere__join', 'PixVerse'],
  ['feishu', 'agirobot__socialrecruitment', 'AGIBOT'],
  ['greenhouse', 'microsoftcorporation', '微软AI'],
  ['greenhouse', 'coreweave', 'CoreWeave'],
  ['greenhouse', 'nebius', 'Nebius'],
  ['ashby', 'lambda', 'Lambda Labs'],
  ['ashby', 'baseten', 'Baseten'],
  ['ashby', 'fireworks', 'Fireworks AI'],
  ['ashby', 'crusoe', 'Crusoe'],
  ['ashby', 'radixark', 'RadixArk'],
  ['ashby', 'modal', 'Modal Labs'],
  ['ashby', 'cerebras', 'Cerebras Systems'],
  ['greenhouse', 'togetherai', 'Together AI'],
  ['ashby', 'mistral.ai', 'Mistral'],
  ['moka', 'deepseek', '深度求索'],
  ['moka', 'moonshot', 'Kimi'],
  ['moka', 'stepfun', '阶跃星辰'],
  ['ashby', 'inferact', 'Inferact'],
]

test('every new board is unique, searchable by name in the subscription sheet and discoverable in chat', () => {
  const keys = CURATED_BOARDS.map(b => b.provider + ':' + b.slug)
  assert.equal(new Set(keys).size, keys.length)
  for (const [provider, slug, alias] of added) {
    const b = findCompanyBoard(provider, slug)
    assert.ok(b, alias)
    assert.ok(boardSearchText(b).includes(alias.toLowerCase()), alias)
    assert.deepEqual(findNamedCompanyBoards('想找' + alias + '的推理岗位'), [b])
    assert.equal(parseBoardInput('https://' + b.host).slug, slug)
    assert.equal(parseBoardInput(provider + ':' + slug).company, b.company)
  }
})

test('every company has distinct localized business copy independent of the market and channel', () => {
  for (const board of CURATED_BOARDS) {
    const zh = boardPosition(board, 'zh')
    const en = boardPosition(board, 'en')
    assert.match(zh, /\p{Script=Han}/u, board.company)
    assert.ok(en && !/\p{Script=Han}/u.test(en), board.company)
    assert.doesNotMatch(zh + ' ' + en, /校园招聘|校招|campus hiring|all-remote/iu)
    for (const position of [zh, en]) assert.ok(boardSearchText(board).includes(position.normalize('NFKC').toLowerCase()), board.company)
  }
  const inf = findCompanyBoard('ashby', 'inferact')
  assert.match(boardPosition(inf, 'zh'), /vLLM/u)
  assert.match(boardPosition(inf, 'en'), /vLLM/u)
  assert.match(boardSearchText(findCompanyBoard('greenhouse', 'coreweave')), /kubernetes/u)
})

test('a campus-only channel is searchable and stays out of experienced-hire recommendations', () => {
  const campus = findCompanyBoard('feishu', 'agirobot__campusrecruitment')
  assert.equal(campus.hiringScope, 'campus')
  assert.match(boardSearchText(campus), /校园招聘/u)
  assert.ok(recommendBoards('上海 校招 具身智能', []).includes(campus))
  for (const text of ['我想在上海找具身智能的社招岗位', 'Experienced hire in embodied AI in Shanghai']) {
    assert.ok(!recommendBoards(text, [], ['feishu:agirobot__campusrecruitment']).includes(campus))
  }
})

test('company mentions respect English boundaries, Chinese aliases, nesting, input order and technical keywords', () => {
  const names = text => findNamedCompanyBoards(text).map(b => b.company)
  assert.deepEqual(names('我想看inferact和Radix Ark，还有KIMI及月之暗面'), ['Inferact','RadixArk','月之暗面'])
  assert.deepEqual(names('vLLM, multimodal, SGLang, AWS Lambda, multi-modal, GPU, linear algebra'), [])
  assert.deepEqual(names('阿里云，之后是阿里。'), ['阿里云','阿里巴巴集团'])
  assert.deepEqual(names('资深工程师，熟悉inferaction、metalambda'), [])
  assert.deepEqual(names('我想找微软AI部门的工作'), ['Microsoft AI'])
  assert.deepEqual(names('微软 Azure、AWS 的工作'), [])
})

test('Feishu hosted portals and root links retain the specific verified company path', () => {
  assert.equal(parseBoardInput('https://aisphere.jobs.feishu.cn').slug, 'aisphere__join')
  assert.equal(parseBoardInput('https://modelbest.jobs.feishu.cn/career/position/123/detail').slug,'modelbest__career')
  assert.equal(parseBoardInput('https://example.jobs.feishu.cn/experienced/position/123/detail').slug,'example__experienced')
  assert.equal(parseBoardInput('https://zhipu-ai.jobs.feishu.cn/index/position/123').slug, 'zhipu-ai')
  assert.equal(parseBoardInput('https://talent.alibaba.com/jobs').slug,'group')
})

test('Ashby dotted tenants work for both public links and explicit IDs, without admitting path segments', () => {
  const board = parseBoardInput('ashby:mistral.ai')
  for (const url of ['https://jobs.ashbyhq.com/mistral.ai/posting-id','https://api.ashbyhq.com/posting-api/job-board/mistral.ai','https://mistral.ai/careers']) {
    assert.deepEqual(parseBoardInput(url), board)
  }
  assert.equal(parseBoardInput('https://api.lever.co/v0/postings/example').slug,'example')
  assert.equal(parseBoardInput('https://boards-api.greenhouse.io/v1/boards/coreweave/jobs/123').company,'CoreWeave')
  for (const slug of ['.mistral','mistral.','mistral..ai','mistral/ai','mistral%2Fai','a'.repeat(101)]) {
    assert.equal(isValidBoardSlug('ashby',slug),false,slug)
  }
  assert.equal(parseBoardInput('greenhouse:mistral.ai'), null)
  assert.equal(parseBoardInput('https://mistral.ai.example.net/careers'),null)
  assert.equal(parseBoardInput('https://user:password@jobs.ashbyhq.com/inferact'),null)
})

test('Moka board ownership is exact for every official project and hash-style job page', () => {
  for (const [slug, project] of Object.entries(MOKA_PROJECTS)) {
    const target = 'https://app.mokahr.com/' + project.kind + '/' + project.org + '/' + project.project
    assert.equal(parseBoardInput(target + '#/job/adc07b52').slug, slug)
  }
  assert.equal(parseBoardInput('https://app.mokahr.com/social-recruitment/high-flyer/140577'), null)
  assert.equal(parseBoardInput('https://app.mokahr.com/apply/other/148506'), null)
  assert.equal(parseBoardInput('moka:other'), null)
  assert.equal(parseBoardInput('https://careers.kimi.com/land-on').slug, 'moonshot')
  assert.equal(parseBoardInput('https://talent.deepseek.com/').slug, 'deepseek')
  assert.equal(parseBoardInput('https://www.stepfun.com/about').slug, 'stepfun')
})

test('the directory counts AGIBOT once and resolves each official entrance independently', () => {
  const social = findCompanyBoard('feishu', 'agirobot__socialrecruitment')
  const campus = findCompanyBoard('feishu', 'agirobot__campusrecruitment')
  assert.deepEqual(CURATED_COMPANIES.filter(b => b.company === '智元机器人'), [social])
  assert.deepEqual(companyBoardChannels({ provider: 'feishu', slug: campus.slug }), [social, campus])
  assert.equal(parseBoardInput('https://www.agibot.com.cn/about/careers').slug, social.slug)
  for (const board of [social, campus]) assert.equal(parseBoardInput('https://' + board.host + '/position/123/detail').slug, board.slug)
  assert.deepEqual(findNamedCompanyBoards('智元社招和校招都看'), [social, campus])
  assert.deepEqual(findNamedCompanyBoards('看看智元的岗位，不考虑应届'), [social])
  assert.equal(findNamedCompanyBoards('DeepSeek只看校招，智元社招').at(-1), social)
  assert.deepEqual(findNamedCompanyBoards('智元校招，还有面壁社招').map(b => b.slug), [campus.slug, 'modelbest__career'])
})

test('a confirmed search replaces only reviewed sibling subscriptions', () => {
  const social = parseBoardInput('feishu:agirobot__socialrecruitment')
  const campus = parseBoardInput('feishu:agirobot__campusrecruitment')
  const other = parseBoardInput('ashby:inferact')
  assert.deepEqual(mergeSearchBoards([campus, other], [social], ['feishu:' + campus.slug, 'ashby:inferact']), [other, social])
  assert.deepEqual(mergeSearchBoards([campus, other], [social]), [campus, other, social])
  assert.deepEqual(mergeSearchBoards([other, social], [social], ['feishu:' + campus.slug]), [other, social])
})

test('company discovery honors the requested scope and a later click preserves the verified channel', () => {
  const social = findCompanyBoard('feishu', 'agirobot__socialrecruitment')
  const campus = findCompanyBoard('feishu', 'agirobot__campusrecruitment')
  assert.equal(resolveNamedHiringBoard(social, 'https://' + campus.host, campus, '社招'), social)
  assert.equal(resolveNamedHiringBoard(social, 'https://' + campus.host, social), campus)
  assert.equal(resolveNamedHiringBoard(social, 'https://www.agibot.com.cn/about/careers', campus), campus)
  assert.equal(resolveNamedHiringBoard(campus, '', findCompanyBoard('ashby', 'inferact')), social)
})
