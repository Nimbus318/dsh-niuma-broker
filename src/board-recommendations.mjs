import { CURATED_BOARDS, CURATED_COMPANIES, companyHiringBoards, hiringScopesFromText } from './company-boards.mjs'

// Match both the business description and the technical keywords for each board.
// More distinctive specialties (e.g. on-device or KV cache) outweigh generic "AI".
const specialties = [
  /端侧|端上|on[- ]device|edge inference|\bnpu\b/iu,
  /异构|heterogeneous/iu, /内存|带宽|memory|bandwidth/iu,
  /集群|cluster/iu, /训练|training/iu, /调度|编排|scheduling|orchestration/iu,
  /强化学习|reinforcement learning/iu, /算子|内核|\bkernels?\b/iu,
  /量化|低精度|quantization|low[- ]precision/iu, /编译器|compilers?/iu,
  /推理|inference|serving/iu, /视频生成|video generation/iu, /具身|embodied/iu,
  /\bvllm\b/iu, /\bsglang\b/iu, /\bkubernetes\b|\bk8s\b/iu,
  /\bgpu\b/iu, /\bcuda\b/iu, /高速互联|\brdma\b/iu,
  /推荐系统|recsys/iu, /自动驾驶|autonomous/iu,
]
const catalog = CURATED_COMPANIES.map(board => {
  const description = [board.tag, board.tagEn, board.keywords].filter(Boolean).join(' ')
  return { board, facets: specialties.filter(facet => facet.test(description)) }
})
const byKey = new Map(CURATED_BOARDS.map(board => [board.provider + ':' + board.slug, board]))
const weight = new Map(specialties.map(facet => [facet, Math.log(1 + catalog.length /
  Math.max(1, catalog.filter(row => row.facets.includes(facet)).length))]))

export function recommendBoards(text, terms, modelKeys = [], defaultScopes = []) {
  const query = [text, ...terms].join(' ')
  const domestic = /中国|国内|上海|北京|杭州|深圳|广州|成都|shanghai|beijing|shenzhen|hangzhou|\bchina\b/iu.test(query)
  const global = /海外|美国|北美|欧洲|新加坡|旧金山|硅谷|英国|加拿大|\b(?:us|usa|united states|europe|singapore|london|san francisco|overseas|canada)\b/iu.test(query)
  const scopes = hiringScopesFromText(text)
  const termScopes = scopes.length ? scopes : hiringScopesFromText(terms.join(' '))
  const eligibleScopes = termScopes.length ? termScopes : (Array.isArray(defaultScopes) ? defaultScopes : [])
  const suggested = [...new Set(modelKeys.flatMap(key => {
    const board = byKey.get(key)
    return board ? companyHiringBoards(board, eligibleScopes) : []
  }))]
  const active = specialties.filter(facet => facet.test(query))
  const ranked = catalog.filter(({ board }) =>
    domestic === global || board.region === (domestic ? 'cn' : 'global')
  ).flatMap(({board, facets}) => {
    const score = facets.reduce((sum, facet) => sum + (active.includes(facet) ? weight.get(facet) : 0), 0)
    return companyHiringBoards(board, eligibleScopes).map(channel => {
      const position = suggested.indexOf(channel)
      return { board: channel, score: score + (position < 0 ? 0 : 2 / (position + 1)) }
    })
  })
  return ranked.filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map(row => row.board)
}
