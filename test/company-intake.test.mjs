import assert from 'node:assert/strict'
import test from 'node:test'
import { proposeIntake } from '../src/intake.mjs'

async function propose(text, result, context = {}) {
  let input
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream(options) {
      input = JSON.parse(options.messages[0].content[0].text)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const proposal = await proposeIntake({ text, context, llm, config: { model: 'fixture:test', sendToModel: true } })
  return { input, proposal }
}
const plan = suggestedBoardKeys => ({
  kind: 'search', summary: '核对招聘源后开始搜索',
  data: { goal: 'GPU 推理工程师', searchTerms: ['推理'], suggestedBoardKeys },
})

test('cold-start role request can propose directory sources but cannot invent a tenant', async () => {
  const { input, proposal } = await propose('我想找上海的 GPU 推理工程师岗位', plan(['feishu:modelbest__career', 'ashby:imaginary', 'feishu:modelbest__career']))
  assert.ok(input.boardCatalog.some(([key]) => key === 'ashby:inferact'))
  assert.ok(proposal.data.boards.some(row => row.slug === 'modelbest__career'))
  assert.ok(proposal.data.boards.length <= 4)
  assert.ok(!proposal.data.boards.some(row => row.slug === 'imaginary'))
})

test('explicit company names take precedence over model suggestions; include Moka and dotted Ashby', async () => {
  const { input, proposal } = await propose('请帮我订阅 Inferact、Mistral、月之暗面和阶跃星辰的推理岗位', plan(['ashby:lambda']))
  assert.equal(input.boardCatalog, undefined)
  assert.deepEqual(proposal.data.boards.map(row => [row.provider, row.slug]), [
    ['ashby','inferact'], ['ashby','mistral.ai'], ['moka','moonshot'], ['moka','stepfun'],
  ])
})

test('search in an existing subscription keeps the user’s chosen sources', async () => {
  const {input, proposal} = await propose('继续帮我找推理工作', plan(['ashby:lambda']), {hasSubscriptions:true})
  assert.equal(input.boardCatalog, undefined)
  assert.deepEqual(proposal.data.boards, [])
})

const social = 'agirobot__socialrecruitment'
const campus = 'agirobot__campusrecruitment'
const agibot = slug => ({ provider: 'feishu', slug, company: '智元机器人' })
const inferact = { provider: 'ashby', slug: 'inferact', company: 'Inferact' }

test('named AGIBOT search uses the requested portal even when the model suggests its sibling', async () => {
  for (const [text, expected] of [
    ['想找智元机器人的社招全职岗位', [social]],
    ['Find experienced roles at AGIBOT', [social]],
    ['想看智元的校招岗位', [campus]],
    ['订阅智元的社招和校招', [social, campus]],
    ['智元只看校招和社招', [social, campus]],
    ['智元的招聘职位有哪些', [social]],
    ['智元的岗位，不看校招', [social]],
    ['把智元之前的校招切换到社招', [social]],
    ['将智元校招换成社招，只看社招', [social]],
    ['原来订阅的智元校招，现在只看社招', [social]],
    ['Switch AGIBOT from campus hiring to experienced hires', [social]],
    ['Replace campus roles with experienced roles at AGIBOT', [social]],
    ['AGIBOT experienced roles instead of campus jobs', [social]],
    ["Don’t switch AGIBOT from campus to experienced roles", [campus]],
    ['智元校招不要切换到社招', [campus]],
  ]) {
    const {proposal} = await propose(text, plan(['feishu:' + campus]))
    assert.deepEqual(proposal.data.boards.map(b => b.slug).sort(), expected.sort(), text)
  }
})

test('explicit recruitment links and keys keep their own channel even next to the company name', async () => {
  for (const channel of [social, campus]) {
    const link = 'https://agirobot.jobs.feishu.cn/' + channel.split('__')[1] + '/position/example/detail'
    for (const ref of [link, 'feishu:' + channel]) {
      const {proposal} = await propose('订阅 AGIBOT 招聘官网 ' + ref, plan([]))
      assert.deepEqual(proposal.data.boards.map(b => b.slug), [channel])
    }
  }
})

test('changing a pending or saved campus subscription routes the next plan to experienced hiring', async () => {
  const old = [agibot(campus), inferact]
  const saved = {hasSubscriptions: true, boards: old}
  const prior = {kind: 'search', data: {goal: '机器人岗位', boards: old}}
  for (const text of ['智元我只想看社招岗位', '改成社招', '将智元校招换成社招，只看社招', 'Switch from campus to experienced hiring']) {
    const {proposal} = await propose(text, plan([]), {...saved, prior})
    assert.deepEqual(proposal.data.boards.map(b => b.slug), [social, inferact.slug], text)
    assert.deepEqual(proposal.data.replacedBoardIds, ['feishu:' + campus], text)
    const next = await propose('也加上 DeepSeek', plan([]), {...saved, prior: proposal})
    assert.deepEqual(next.proposal.data.replacedBoardIds, ['feishu:' + campus])
    assert.ok(!next.proposal.data.boards.some(board => board.slug === campus))
    const reverse = await propose('还是只看校招', plan([]), {...saved, prior: proposal})
    assert.deepEqual(reverse.proposal.data.boards.map(b => b.slug), [campus, inferact.slug])
    assert.equal(reverse.proposal.data.replacedBoardIds, undefined)
  }
  const {proposal} = await propose('找智元的社招岗位', plan([]), saved)
  assert.deepEqual(proposal.data.boards.map(b => b.slug), [social])
  assert.deepEqual(proposal.data.replacedBoardIds, ['feishu:' + campus])
})

test('adding a channel keeps pending and saved siblings and does not remove other subscriptions', async () => {
  const old = [agibot(campus), inferact]
  const context = {hasSubscriptions: true, boards: old, prior: {kind: 'search', data: {boards: old}}}
  for (const text of ['智元的社招也加上', 'Also include AGIBOT experienced roles', '智元社招和校招都看看']) {
    const {proposal} = await propose(text, plan([]), context)
    assert.deepEqual(proposal.data.boards.map(b => b.slug).sort(), [campus, social, inferact.slug].sort(), text)
    assert.equal(proposal.data.replacedBoardIds, undefined)
  }
  const {proposal} = await propose('我要找 DeepSeek 的社招岗位', plan([]), context)
  assert.ok(proposal.data.boards.some(b => b.slug === campus))
  assert.equal(proposal.data.replacedBoardIds, undefined)
})

test('generic recommendations choose one eligible AGIBOT channel and redirect a stale suggestion', async () => {
  for (const [text, wrong, expected] of [
    ['帮我找上海的具身智能社招岗位', campus, social],
    ['帮我找上海的具身智能校招岗位', social, campus],
    ['帮我找上海的具身智能岗位', campus, social],
  ]) {
    const {proposal} = await propose(text, {...plan([]), data: { goal: '具身智能', searchTerms: ['具身智能'], suggestedBoardKeys: ['feishu:' + wrong] }})
    assert.deepEqual(proposal.data.boards.filter(b => b.company === '智元机器人').map(b => b.slug), [expected], text)
  }
})

test('pasting a public Moka JD as a job preserves its fragment including the position ID', async () => {
  const url = 'https://app.mokahr.com/social-recruitment/high-flyer/140576#/job/43f8551a-4235-4d5e-a9a7-44386cd79795'
  const { proposal } = await propose('帮我收藏 DeepSeek 的这个岗位 '+url, {kind:'job', data:{company:'DeepSeek',title:'大模型训练/推理框架工程师',url}})
  assert.equal(proposal.data.url, url)
})

test('an on-device role with no company or model-suggested key still finds ModelBest', async () => {
  const {proposal} = await propose('我想在上海找端侧大模型推理的社招全职岗位，做过 GPU 推理和内存带宽优化', plan([]))
  assert.equal(proposal.data.boards[0].slug, 'modelbest__career')
  assert.ok(!proposal.data.boards.some(board => board.slug.includes('campusrecruitment')))
})

test('a search keeps explicit target locations the model omitted, including alternatives', async () => {
  for (const [input, locations] of [
    ['我想去美国做 vLLM 推理引擎或 GPU kernel 的全职岗位，请订阅 Inferact 官网。', ['美国']],
    ['我想在上海找端侧大模型推理的社招全职岗位。', ['上海']],
    ['帮我订阅 DeepSeek 的北京或杭州的推理岗位。', ['北京', '杭州']],
    ['Find me inference roles in the U.S. and subscribe to Inferact.', ['United States']],
  ]) {
    const { proposal } = await propose(input, plan([]))
    for (const location of locations) assert.ok(proposal.data.goal.includes(location), input)
    assert.deepEqual(proposal.data.searchTerms, ['推理'])
  }
})

test('search does not duplicate already-retained places or turn history and exclusions into destinations', async () => {
  const response = { kind: 'search', data: { goal: '上海全职工程师', searchTerms: ['推理', '北京'] } }
  const { proposal } = await propose('请找上海或北京的全职岗位。', response)
  assert.equal(proposal.data.goal, response.data.goal)
  assert.deepEqual(proposal.data.searchTerms, response.data.searchTerms)
  for (const input of [
    '我以前在美国工作，不考虑上海。现在想去北京找 GPU 推理工程师',
    '之前在美国工作，上海不考虑。请找北京的推理岗位。',
    '我只考虑北京的推理岗位，以前在美国工作，还不想去上海。',
  ]) {
    const { proposal: result } = await propose(input, plan([]))
    assert.ok(result.data.goal.includes('北京'), input)
    assert.doesNotMatch(result.data.goal, /美国|上海/u, input)
  }
  const { proposal: en } = await propose("I don't want to work in the US. Find me roles in Beijing.", plan([]))
  assert.match(en.data.goal, /Beijing/u)
  assert.doesNotMatch(en.data.goal, /United States/u)
})

test('a company-only addition keeps a saved search or a pending search without inventing a new constraint', async () => {
  const existing = { goal: '北京或杭州的推理工程师', searchTerms: ['vLLM', 'CUDA'] }
  for (const context of [existing, { prior: { kind: 'search', data: existing } }]) {
    const { proposal } = await propose('也请帮我加上 DeepSeek 和 Mistral 的招聘官网。', plan([]), context)
    assert.equal(proposal.data.goal, existing.goal)
    assert.deepEqual(proposal.data.searchTerms, existing.searchTerms)
    assert.deepEqual(proposal.data.boards.map(board => board.slug), ['deepseek', 'mistral.ai'])
    const changed = await propose('现在想去美国做推理，也加上 Inferact。', plan([]), context)
    assert.match(changed.proposal.data.goal, /美国/u)
    assert.doesNotMatch(changed.proposal.data.goal, /北京|杭州/u)
  }
})

test('a model cannot promote a known foreign-only role above stretch, while unknown or matching alternatives remain eligible', async () => {
  const { buildPatrolSearchProfile, triageBatchWithLlm } = await import('../src/job-triage.mjs')
  const resumeText = '# Candidate\n\n## Experience\n- Built vLLM GPU CUDA PyTorch distributed inference engine.'
  const profile = buildPatrolSearchProfile({ goal: '美国全职 vLLM GPU CUDA 推理引擎工程师', searchTerms: ['vLLM', 'GPU', 'CUDA'], resumeText })
  const jobs = ['Toronto, Canada', 'Remote', 'Toronto or San Francisco', 'Paris / Remote Worldwide'].map((location, id) => ({
    id: 'j' + id, location, title: 'vLLM GPU CUDA Inference Engineer', jd: 'vLLM GPU CUDA PyTorch Inference',
  }))
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    async *stream() {
      const items = jobs.map(({ id }) => ({
        id,
        D: 3,
        E: 3,
        L: null,
        jdIds: ['J1'],
        resumeIds: ['R1'],
        reason: 'Ideal location and skills.',
      }))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ items }) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const batch = await triageBatchWithLlm({ jobs, profile, resumeText, llm, config: { model: 'fixture:test', sendToModel: true } })
  assert.ok(batch.every(row => row.mode === 'llm'))
  assert.equal(batch[0].tier, 'stretch')
  assert.equal(batch[0].score, undefined)
  assert.match(batch[0].reason, /目标国家以外/u)
  assert.deepEqual(batch.slice(1).map(row => row.tier), ['top', 'top', 'top'])
  const [offline] = await triageBatchWithLlm({ jobs, profile })
  assert.ok(offline.score <= 59)
})

test('one conversation can select separate channels across companies and revisit only those targets', async () => {
  const first = (await propose('请订阅百度校招、携程社招和 Inferact 校招', plan(['ashby:inferact']))).proposal
  assert.deepEqual(first.data.boards.map(b => b.provider + ':' + b.slug), ['baidu:campus', 'trip:social', 'ashby:inferact__campus'])
  const saved = {hasSubscriptions: true, boards: [...first.data.boards, { provider: 'ashby', slug: 'mistral.ai' }]}
  const change = (await propose('都改成社招', plan([]), { ...saved, prior: first })).proposal
  assert.deepEqual(change.data.boards.map(b => b.provider + ':' + b.slug), ['baidu:social','trip:social','ashby:inferact__experienced'])
})

test('a named employer without a verified campus feed returns an official link and adds no unrelated board', async () => {
  const {proposal} = await propose('只查 Anthropic 的校招岗位', plan(['ashby:openai']))
  assert.equal(proposal.kind, 'answer')
  assert.match(proposal.data.answer, /https:\/\/www\.anthropic\.com\/careers/u)
  assert.equal(proposal.data.boards, undefined)
})

test('native hash-based posting and campus portal URLs retain the selected channel', async () => {
  const link = 'https://job.ctrip.com/#/campus/job-detail/MJ036717'
  const {proposal} = await propose('订阅这个校招入口 '+link, plan([]))
  assert.deepEqual(proposal.data.boards.map(b => b.provider + ':' + b.slug), ['trip:campus'])
  const job = (await propose('记一下这个岗位 '+link, {kind:'job',data:{title:'算法工程师',company:'携程',url:link}})).proposal
  assert.equal(job.data.url, link)
})

test('switching previous subscriptions checks campus availability even if company names are omitted', async () => {
  const prior = {kind:'search',data:{goal:'技术方向',boards:[{provider:'greenhouse',slug:'anthropic',company:'Anthropic'}]}}
  const {proposal} = await propose('改成校招', plan([]), { prior })
  assert.equal(proposal.kind, 'answer')
  assert.match(proposal.data.answer, /anthropic.com/u)
  const boards = [...prior.data.boards,{ provider:'baidu', slug:'social', company:'百度' }]
  const both = await propose('所有公司改成校招', plan([]), {prior:{kind:'search',data:{goal:'技术方向',boards}},boards})
  assert.deepEqual(both.proposal.data.boards.map(b=>b.slug), ['campus'])
  assert.ok(both.proposal.data.replacedBoardIds.includes('greenhouse:anthropic'))
  assert.equal(both.proposal.data.unavailableChannels[0].company, 'Anthropic')
})
