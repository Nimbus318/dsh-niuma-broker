// Editorial JD highlighting, JD black-talk (黑话) translation, risk detection,
// and company due-diligence helpers grounded strictly in what the agent knows about the user.

const CURATED_TERMS = [
  // AI / LLM / Agent / ML Systems
  'AI Infra', 'AI Infrastructure', 'AI 基础设施', '大模型', '大语言模型', '多模态', '智能体',
  'Agent', 'Agent 平台', 'Agentic', 'LLM', 'VLM', 'RAG', 'MCP', 'Function Calling', 'Tool Use',
  'RLHF', 'GRPO', 'PPO', 'DPO', 'SFT', 'Pretrain', 'Post-train', 'Fine-tuning', '微调', '强化学习',
  'Prefill/Decode', 'Prefill', 'Decode', 'KV-Cache', 'KV Cache', 'Speculative Decoding', 'MoE',
  'FP8', 'INT8', 'INT4', 'Quantization', '量化', '推理引擎', '推理网关', '推理优化', '推理服务',
  '推理平台', '模型推理', '推理', '训练框架', '训练平台', '模型训练', '训练集群', '分布式训练',
  'CUDA', 'PyTorch', 'TensorRT', 'TensorRT-LLM', 'vLLM', 'SGLang', 'Megatron', 'DeepSpeed',
  'Triton', 'FlashAttention', 'ONNX', 'JAX', 'Transformers', 'HuggingFace', 'LangGraph', 'LangChain',
  'GPU', 'NPU', 'TPU', 'H800', 'H100', 'A100', 'A800', 'B200', 'Ascend', '昇腾',
  'RDMA', 'InfiniBand', 'RoCE', 'NCCL', 'NVLink', '算力调度', '算力集群', '算力平台', '算力',
  '异构算力', '异构计算', '异构', '千卡', '万卡', '混部', '弹性算力', '在离线混部',
  // Cloud Native / Systems / Infra / Reliability
  'Kubernetes', 'K8s', 'Docker', 'Containerd', 'MicroVM', 'Firecracker', 'gVisor', 'Kata',
  'Sandbox', '沙箱', '弹性沙箱', '云原生', '容器编排', '容器', '集群调度', '调度系统', '调度',
  'Ray', 'Slurm', 'Volcano', 'Kueue', 'YARN', 'Nomad', 'Service Mesh', 'Istio', 'Envoy',
  'OpenTelemetry', 'Prometheus', 'VictoriaMetrics', 'Grafana', 'Datadog', 'Jaeger', 'eBPF',
  '可观测性', '可观测', '监控告警', '监控', '告警', '链路追踪', '稳定性', '高可用', '高并发',
  '低延迟', '多租户', '租户隔离', '配额治理', '配额', '资源池', '容量规划', '弹性伸缩', '扩缩容',
  '分布式系统', '分布式存储', '分布式', '微服务', '服务网格', '消息队列', '缓存', '网关',
  'CI/CD', 'DevOps', 'GitOps', 'Terraform', 'Helm', 'SRE', 'FinOps', 'SLA', 'SLO',
  'TTFT', 'TPOT', 'P99', 'QPS', 'TPS', 'MTTR', '灰度发布', '容灾', '多活', '异地双活',
  '成本治理', '降本增效', '成本优化', '性能优化', '吞吐优化', '负载均衡', '内核', 'Linux',
  // Languages / Frameworks / Data
  'Golang', 'Go', 'Rust', 'Python', 'C++', 'TypeScript', 'JavaScript', 'Java', 'Scala', 'SQL',
  'React', 'Next.js', 'Vue', 'Node.js', 'GraphQL', 'gRPC', 'Protobuf', 'REST', 'WebSocket',
  'PostgreSQL', 'MySQL', 'Redis', 'Kafka', 'Pulsar', 'ClickHouse', 'Elasticsearch', 'Milvus',
  'etcd', 'TiDB', 'Spark', 'Flink', 'Airflow', 'Snowflake', 'BigQuery', 'DuckDB', 'S3', 'Ceph',
  // Engineering Leadership / Product / Architecture
  'Tech Lead', 'Staff', 'Principal', 'Infrastructure', 'Platform', 'Architecture', 'Full-stack',
  'Applied AI', 'Developer Tools', 'DevTools', 'Observability', 'Inference', 'Serving', 'Scheduler',
  'Multi-tenant', 'Distributed', 'Data Pipeline', 'Evaluation', 'Eval', 'Benchmark', 'Prompt',
  '架构设计', '核心架构', '系统架构', '技术规划', '跨团队', '工程效率', '研发效能', '带教',
  '产品经理', 'AI 产品', '前端', '后端', '全栈', '客户端', '算法工程师', '基础设施', '平台工程',
]

// Generic role/org phrases that should NOT be flagged as "uncovered technical skills to study"
const GENERIC_NON_STUDY_TERMS = new Set([
  'ai', 'ai infra', 'ai infrastructure', 'ai 基础设施', '大模型', '大语言模型', '基础设施',
  '平台工程', '架构设计', '核心架构', '系统架构', '技术规划', '跨团队', '工程效率', '研发效能',
  '带教', '产品经理', 'ai 产品', '前端', '后端', '全栈', '客户端', '算法工程师',
  'tech lead', 'staff', 'principal', 'infrastructure', 'platform', 'architecture', 'full-stack',
  'applied ai', 'developer tools', 'devtools', '高可用', '高并发', '低延迟', '稳定性',
  '性能优化', '成本优化', '降本增效', '成本治理', '调度', '推理', '训练', '监控', '告警',
  '容器', '缓存', '网关', '内核', '算力', '配额', '资源池', '容量规划',
])

const BONUS_HEADING_RE = /(?:加分项|优先条件|加分条件|优先考虑|nice to have|preferred|bonus|plus)/iu

const LOCATION_TERMS = [
  '上海', '北京', '深圳', '杭州', '广州', '成都', '苏州', '南京', '香港', '新加坡',
  'Singapore', 'Remote', '远程', '居家办公', 'Hybrid', '混合办公', 'San Francisco', 'New York', 'Tokyo',
]

// High-signal Chinese & global tech JD black-talk / risk indicators with plain-language translation
export const JD_JARGON_RULES = [
  {
    id: 'overtime-pressure',
    category: '加班 / 强度信号',
    categoryEn: 'Overtime / Intensity Signal',
    terms: [
      '抗压能力强', '较强的抗压能力', '良好抗压能力', '抗压能力', '承受较大压力', '高强度工作', '适应高强度',
      '接受加班', '能适应加班', '快节奏高压', '结果导向', '使命必达', '狼性',
      'work hard, play hard', 'work hard play hard', 'high-pressure', 'tight deadlines', 'tight timeline',
      'long hours', 'go the extra mile', 'hustle culture', 'high intensity',
    ],
    translation: '通常意味着交付排期紧或常态化加班，对工作时长和响应速度要求较高。',
    translationEn: 'Often signals tight release schedules, frequent overtime, and high expectations for working hours and responsiveness.',
    question: '团队过去一个季度的平均下班时间和发版节奏大概是什么样？',
    questionEn: 'What have typical working hours and release cadence looked like for this team over the past quarter?',
  },
  {
    id: 'oncall-urgent',
    category: '值班 / 补位信号',
    categoryEn: 'On-Call / Urgent Backfill Signal',
    terms: [
      '7*24', '7x24', '7×24', '随时响应', '全天候响应', '急招', '立即到岗', '快速到岗',
      'on-call', 'On-Call', 'oncall', '24/7', '24x7', 'immediate start', 'urgent hire', 'after-hours', 'pager rotation',
    ],
    translation: '可能伴随高频 On-Call 夜间值班，或是前任突然离职留下的紧急交接缺口。',
    translationEn: 'May involve heavy after-hours on-call rotation or an urgent backfill left by a sudden departure.',
    question: '这个岗位是业务扩编还是替补？On-Call 轮值频率和调休机制如何？',
    questionEn: 'Is this a new headcount or backfill? How frequent is the on-call rotation and how are off-hours compensated?',
  },
  {
    id: 'boundary-blur',
    category: '职责边界信号',
    categoryEn: 'Scope & Role Boundary Signal',
    terms: [
      '不设边界', '不设限', '扁平化管理', '创业心态', '创业精神', '身兼数职', '一专多能',
      'wear many hats', 'wearing many hats', 'scrappy', 'ambiguity', 'high ambiguity', 'no ego',
      'other duties as assigned', 'like a family', 'we are a family', 'rockstar', 'ninja', '10x engineer',
      'flat hierarchy', 'flat organization', 'jack of all trades',
    ],
    translation: '常见于人手紧张或早期团队：一人需兼顾多角色，需求变更快、流程规范少。',
    translationEn: 'Common in lean or early-stage teams where one person covers multiple roles amid shifting priorities and light process.',
    question: '目前小组有几位工程师？入职前 90 天最明确要交付的 1–2 个里程碑是什么？',
    questionEn: 'How many engineers are currently on the team, and what are the top 1–2 concrete milestones expected in the first 90 days?',
  },
  {
    id: 'zero-to-one',
    category: '业务成熟度信号',
    categoryEn: 'Product Maturity Signal',
    terms: [
      '从0到1', '从 0 到 1', '0到1', '0-1', '快速试错', '快速迭代', '摸着石头过河',
      'fast-paced', 'fast paced', 'high urgency', 'move fast', '0-to-1', '0 to 1', 'zero to one',
      'rapidly changing', 'shifting priorities',
    ],
    translation: '业务或架构仍在早期探索期，试错与推倒重来概率较高，稳定性与沉淀相对弱。',
    translationEn: 'Product or architecture is still in early exploration with higher pivot/rework probability and less operational maturity.',
    question: '这个方向目前处于验证期还是规模化阶段？核心业务指标和投入周期怎么定？',
    questionEn: 'Is this initiative still in validation or scaling mode, and what metrics define success over the next 6–12 months?',
  },
  {
    id: 'comp-opaque',
    category: '薪酬 / 福利信号',
    categoryEn: 'Compensation & Benefits Signal',
    terms: [
      '有竞争力的薪酬', '极具竞争力的薪酬', '薪资面议', '期权激励', '股权激励', '丰厚期权', '弹性工作', '弹性办公', '弹性打卡',
      'competitive salary', 'competitive compensation', 'commensurate with experience',
      'unlimited pto', 'unlimited vacation', 'flexible time off', 'generous equity',
    ],
    translation: '薪酬结构或现金/期权占比不透明；部分公司「弹性」只指下班弹性、不包加班费。',
    translationEn: 'Cash vs. equity split is opaque; "unlimited PTO" or "flexible hours" can sometimes mask heavy workload or low actual time off.',
    question: '薪资包里现金 Base、年终月数与期权占比大概如何？期权行权和回购条款怎么安排？',
    questionEn: 'What is the base/bonus/equity band for this level, and how much PTO do teammates actually take per year?',
  },
  {
    id: 'middle-office-jargon',
    category: '协作 / 话语权信号',
    categoryEn: 'Org Alignment / Ownership Signal',
    terms: [
      '深度赋能', '业务赋能', '抓手', '组合拳', '打通闭环', '沉淀方法论', '拉通对齐', '生态共建',
      'influence without authority', 'matrix organization', 'dotted line', 'stakeholder buy-in', 'cross-functional alignment',
    ],
    translation: '偏中台或强跨团队协调型岗位，容易陷入「背指标却没业务决策权」的拉扯。',
    translationEn: 'Often a platform or matrix role where you carry delivery expectations across teams without direct decision authority.',
    question: '这个岗位对技术架构和排期有直接拍板权吗？绩效主要看业务指标还是技术产出？',
    questionEn: 'Does this role have direct authority over technical roadmap and priorities, and how is performance evaluated?',
  },
  {
    id: 'self-driven-unmanaged',
    category: '培养 / 管理信号',
    categoryEn: 'Autonomy / Support Signal',
    terms: [
      '极强的自驱力', '高度自驱', '自驱力强', '自我驱动',
      'without heavy PM overhead', 'self-directed', 'high ownership', 'self-starter',
      'hit the ground running', 'minimal supervision', 'little guidance',
    ],
    translation: '很少有手把手带教或清晰 PRD，要求自己定义问题并推动上下游落地。',
    translationEn: 'Light onboarding or sparse specs—expected to scope ambiguous problems independently and drive execution end-to-end.',
    question: '需求一般由谁来拆解？团队的技术评审、文档沉淀和导师机制完善吗？',
    questionEn: 'How are technical specs and design reviews handled, and what does onboarding look like for a new senior hire?',
  },
  {
    id: 'travel-onsite',
    category: '出差 / 驻场信号',
    categoryEn: 'Travel / On-Site Signal',
    terms: [
      '接受出差', '频繁出差', '驻场', '外派', '客户现场',
      'frequent travel', 'willing to travel', 'client site', '5 days in office', '5 days a week in office',
    ],
    translation: '可能涉及高频出差或客户现场驻场交付，直接影响个人生活节奏。',
    translationEn: 'May require frequent travel, client-site work, or strict full-week on-site attendance.',
    question: '大概每月出差/驻场占比多少？差旅补贴与调休怎么算？',
    questionEn: 'What percentage of travel or in-office attendance is strictly required, and how flexible is the policy?',
  },
]

const ASCII_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your', 'our', 'you',
  'are', 'not', 'but', 'all', 'can', 'has', 'had', 'was', 'were', 'been', 'being', 'about',
  'into', 'over', 'after', 'before', 'between', 'under', 'above', 'more', 'most', 'some',
  'such', 'than', 'then', 'when', 'where', 'which', 'while', 'what', 'who', 'how', 'why',
  'work', 'working', 'team', 'teams', 'role', 'roles', 'build', 'building', 'built', 'make',
  'making', 'using', 'used', 'use', 'help', 'high', 'strong', 'experience', 'years', 'year',
  'skills', 'skill', 'ability', 'good', 'great', 'best', 'new', 'well', 'also', 'other',
  'both', 'each', 'many', 'much', 'very', 'just', 'like', 'including', 'across', 'within',
  'through', 'based', 'related', 'support', 'ensure', 'design', 'develop', 'developing',
  'development', 'engineering', 'engineer', 'engineers', 'software', 'system', 'systems',
  'product', 'products', 'service', 'services', 'company', 'companies', 'business', 'customer',
  'customers', 'user', 'users', 'data', 'code', 'time', 'world', 'global', 'local', 'core',
  'key', 'main', 'part', 'level', 'senior', 'lead', 'manager', 'management', 'technical',
  'technology', 'technologies', 'solution', 'solutions', 'problem', 'problems', 'complex',
  'scale', 'large', 'fast', 'real', 'modern', 'quality', 'reliability', 'security', 'access',
  'open', 'full', 'end', 'own', 'drive', 'driving', 'deliver', 'delivery', 'impact', 'growth',
  'opportunity', 'opportunities', 'collaborate', 'collaboration', 'communication', 'written',
  'verbal', 'degree', 'computer', 'science', 'equivalent', 'preferred', 'required', 'plus',
  'bonus', 'location', 'office', 'benefits', 'salary', 'equity', 'health', 'apply', 'join',
  'http', 'https', 'www', 'com', 'org', 'net', 'email', 'example', 'github', 'linkedin',
])

const isAsciiTerm = term => /^[\x20-\x7e]+$/u.test(term)
const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function termRegex(term, global = false) {
  const escaped = escapeRegExp(term)
  const flags = global ? 'giu' : 'iu'
  if (isAsciiTerm(term)) {
    const left = /^[A-Za-z0-9]/u.test(term) ? '(?<![A-Za-z0-9_])' : ''
    const right = /[A-Za-z0-9]$/u.test(term) ? '(?![A-Za-z0-9_+#-]|\\.[A-Za-z0-9])' : ''
    return new RegExp(`${left}${escaped}${right}`, flags)
  }
  return new RegExp(escaped, flags)
}

function containsTerm(corpus, term) {
  if (!corpus || !term) return false
  return termRegex(term, false).test(corpus)
}

function extractAsciiTokens(text) {
  if (!text) return []
  const matches = text.match(/\b[A-Za-z][A-Za-z0-9+.#/-]{2,26}\b/gu) || []
  const out = new Set()
  for (const raw of matches) {
    const clean = raw.replace(/^[./-]+|[./-]+$/gu, '')
    if (clean.length < 3 || clean.length > 24) continue
    if (/^\d+$/u.test(clean) || /^https?/iu.test(clean)) continue
    if (ASCII_STOPWORDS.has(clean.toLowerCase())) continue
    const looksTechnical = /[A-Z].*[A-Z]|[0-9]|[+#.-]/u.test(clean)
    if (looksTechnical) out.add(clean)
  }
  return [...out]
}

function extractGapPhrases(gapsText) {
  if (!gapsText || typeof gapsText !== 'string') return []
  const found = new Set()
  for (const m of gapsText.matchAll(/[「『“"《]([^」』”"》\n]{2,24})[」』”"》]/gu)) {
    const phrase = m[1].trim()
    if (phrase.length >= 2) found.add(phrase)
  }
  for (const term of CURATED_TERMS) {
    if (containsTerm(gapsText, term)) found.add(term)
  }
  for (const tok of extractAsciiTokens(gapsText)) {
    found.add(tok)
  }
  return [...found]
}

export function buildUserJdSignals({
  resumes = [],
  evidence = [],
  reflections = [],
  config = {},
  job = null,
  tailoredGaps = '',
  locale = 'zh',
} = {}) {
  const isEn = locale === 'en'
  const activeResumes = (Array.isArray(resumes) ? resumes : [])
    .filter(r => r && r.status !== 'revoked' && r.status !== 'rejected')
  const latestApproved = activeResumes.findLast(r => r.status === 'approved' && !r.opportunityId)
    ?? activeResumes.findLast(r => r.status === 'approved')
    ?? activeResumes.at(-1)
  const resumeText = typeof latestApproved?.text === 'string' ? latestApproved.text : ''

  const activeEvidence = (Array.isArray(evidence) ? evidence : [])
    .filter(e => e && (e.status === 'approved' || e.status === 'pending'))
  const evidenceText = activeEvidence
    .map(e => [e.title, e.text, e.role, e.impact].filter(Boolean).join(' '))
    .join('\n')

  const activeReflections = (Array.isArray(reflections) ? reflections : [])
    .filter(r => r && r.status !== 'rejected' && r.status !== 'revoked')
  const reflectionText = activeReflections.map(r => r.text || '').join('\n')

  const goalText = typeof config?.goal === 'string' ? config.goal : ''
  const searchTerms = Array.isArray(config?.searchTerms)
    ? config.searchTerms.map(t => String(t || '').trim()).filter(t => t.length >= 2 && t.length <= 36)
    : []
  const gapsText = [job?.draft?.gaps, tailoredGaps].filter(Boolean).join('\n')
  const jdText = typeof job?.jd === 'string' ? job.jd : ''

  // Map key(lowercase) -> { term, kind: 'match' | 'focus' | 'gap' | 'risk', reason, priority, ...meta }
  const map = new Map()
  const put = (term, kind, reason, priority, meta = {}) => {
    const clean = String(term || '').trim()
    if (!clean || clean.length < 2 || clean.length > 40) return
    if (kind !== 'risk' && isAsciiTerm(clean) && ASCII_STOPWORDS.has(clean.toLowerCase())) return
    const key = clean.toLowerCase()
    const prev = map.get(key)
    if (!prev || priority > prev.priority) {
      map.set(key, { term: clean, kind, reason, priority, ...meta })
    } else if (prev && priority === prev.priority && !prev.reason.includes(reason)) {
      prev.reason = `${prev.reason} · ${reason}`
    }
  }

  // 1. User's explicit search terms & goal direction (focus)
  for (const term of searchTerms) {
    put(term, 'focus', isEn ? 'From your search keywords' : '来自你的寻岗关键词', 2)
  }
  for (const loc of LOCATION_TERMS) {
    if (containsTerm(goalText, loc)) put(loc, 'focus', isEn ? 'Matches your target location' : '符合你的目标工作地点', 2)
  }
  for (const term of CURATED_TERMS) {
    if (containsTerm(goalText, term)) put(term, 'focus', isEn ? 'Matches your target direction' : '来自你的求职方向目标', 2)
    if (containsTerm(reflectionText, term)) put(term, 'focus', isEn ? 'From your career notes' : '来自你的职业思考记忆', 2)
  }

  // 2. User's verified resume + work achievements (from DSH conversations / recordings / manual)
  for (const term of CURATED_TERMS) {
    const inResume = containsTerm(resumeText, term)
    const inEvidence = containsTerm(evidenceText, term)
    if (inResume && inEvidence) {
      put(term, 'match', isEn ? 'Matched in resume & distilled achievements' : '命中简历与对话工作成果', 3)
    } else if (inEvidence) {
      put(term, 'match', isEn ? 'Matched in career library achievements' : '命中履历库工作成果记忆', 3)
    } else if (inResume) {
      put(term, 'match', isEn ? 'Matched in your resume skills & experience' : '命中你的简历经历与技能', 3)
    }
  }

  if (jdText) {
    const userTechTokens = new Set([
      ...extractAsciiTokens(resumeText),
      ...extractAsciiTokens(evidenceText),
    ])
    for (const tok of userTechTokens) {
      if (containsTerm(jdText, tok)) {
        const inEv = containsTerm(evidenceText, tok)
        put(tok, 'match', inEv
          ? (isEn ? 'Matched in career library achievements' : '命中履历库工作成果记忆')
          : (isEn ? 'Matched in your resume skills & experience' : '命中你的简历经历与技能'), 3)
      }
    }
  }

  // 2.5 Uncovered high-value technical terms / bonus items in THIS JD that are NOT in user's resume or evidence yet
  if (jdText) {
    const bonusLines = []
    let inBonus = false
    for (const rawLine of jdText.replace(/\r\n?/gu, '\n').split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (HEADING_RE.test(line) && line.length <= 48) {
        inBonus = BONUS_HEADING_RE.test(line)
        continue
      }
      if (inBonus || /优先|加分|preferred|bonus|nice to have/iu.test(line)) {
        bonusLines.push(line)
      }
    }
    const bonusCorpus = bonusLines.join('\n')

    for (const term of CURATED_TERMS) {
      if (GENERIC_NON_STUDY_TERMS.has(term.toLowerCase())) continue
      if (!containsTerm(jdText, term)) continue
      const key = term.toLowerCase()
      if (map.has(key) && map.get(key).kind === 'match') continue
      const isBonus = Boolean(bonusCorpus && containsTerm(bonusCorpus, term))
      put(
        term,
        'learn',
        isBonus
          ? (isEn ? 'Preferred skill not yet on resume (click for quick study)' : 'JD 加分项 · 简历暂未覆盖（点此速查背景或发起学习调研）')
          : (isEn ? 'Key tech not yet on resume (click for quick study)' : '岗位关键技术 · 简历暂未覆盖（点此速查背景或发起学习调研）'),
        3.5,
        { isBonus },
      )
    }
  }

  // 3. AI-identified gaps / attention items
  for (const phrase of extractGapPhrases(gapsText)) {
    const key = phrase.toLowerCase()
    if (!map.has(key) || map.get(key).kind !== 'match') {
      put(phrase, 'gap', isEn ? 'AI-flagged gap / requirement to address' : 'AI 提示重点关注 / 待补充要求', 4)
    }
  }

  // 4. AI deep-intel risk notes — bind directly onto real JD spans so clicking "locate" always finds & highlights them.
  // Avoids noisy static keyword rules (e.g. flagging polite boilerplate like "自我驱动" before AI reads full context).
  if (jdText) {
    const intelRisks = Array.isArray(job?.intel?.riskNotes) ? job.intel.riskNotes : []
    for (const note of intelRisks) {
      const rawTerm = String(note?.term || '').trim()
      if (!rawTerm) continue
      const meaning = String(note?.meaning || note?.translation || '').trim()
      const question = String(note?.question || '').trim()
      let matchedSpan = containsTerm(jdText, rawTerm) ? rawTerm : ''
      if (!matchedSpan) {
        const subParts = rawTerm.split(/[、，,/\s及与和]+/u).map(s => s.trim()).filter(s => s.length >= 2)
        subParts.sort((a, b) => b.length - a.length)
        matchedSpan = subParts.find(part => containsTerm(jdText, part)) || ''
      }
      if (matchedSpan) {
        put(matchedSpan, 'risk', meaning || (isEn ? 'AI-detected risk signal' : 'AI 识别风险信号'), 5.5, {
          category: isEn ? 'AI Risk Signal' : 'AI 风险信号',
          translation: meaning,
          question,
          noteTerm: rawTerm,
        })
      }
    }
  }

  return [...map.values()]
}

const HEADING_RE = /^(?:#{1,4}\s+.+|(?:岗位职责|职位描述|工作职责|任职要求|任职资格|岗位要求|加分项|优先条件|关于我们|团队介绍|福利待遇|基本要求|核心职责|职位亮点|工作内容|职责描述|能力要求)[：:]?|(?:What you(?:'|’)ll do|What we(?:'|’)re looking for|Who you are|About (?:the role|us|the team)|Responsibilities|Requirements|Qualifications|Nice to have|Preferred qualifications|Our tech|Tech stack|Location & work mode|Benefits|Compensation)\s*:?)$/iu
const BULLET_RE = /^\s*(?:[-•·▪◦*]|\d+[.)、]|[（(]\d+[)）])\s+(.+)$/u

function splitJdBlocks(jdText) {
  const rawLines = String(jdText || '').replace(/\r\n?/gu, '\n').split('\n')
  const blocks = []
  let listItems = []
  const flushList = () => {
    if (listItems.length) {
      blocks.push({ type: 'list', items: listItems })
      listItems = []
    }
  }

  for (const raw of rawLines) {
    const line = raw.trim()
    if (!line) { flushList(); continue }
    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      listItems.push(bullet[1].trim())
      continue
    }
    flushList()
    if (HEADING_RE.test(line) && line.length <= 48) {
      blocks.push({ type: 'heading', text: line.replace(/^#{1,4}\s+/u, '').replace(/[：:]$/u, '') })
    } else {
      blocks.push({ type: 'paragraph', text: line })
    }
  }
  flushList()
  return blocks
}

export function annotateJd(jdText, signals = []) {
  const text = typeof jdText === 'string' ? jdText.trim() : ''
  if (!text) {
    return { blocks: [], summary: { matched: [], focused: [], learn: [], gaps: [], risks: [] }, totalHighlights: 0 }
  }

  const activeSignals = (Array.isArray(signals) ? signals : [])
    .filter(sig => sig?.term && containsTerm(text, sig.term))
    .sort((a, b) => b.term.length - a.term.length || b.priority - a.priority)

  const seenCount = new Map()
  const MAX_PER_TERM = 3
  const foundMatched = new Map()
  const foundFocused = new Map()
  const foundLearn = new Map()
  const foundGaps = new Map()
  const foundRisks = new Map()
  let totalHighlights = 0

  const highlightLine = line => {
    if (!activeSignals.length || !line) return [{ text: line }]
    const spans = []
    const occupied = new Array(line.length).fill(false)

    for (const sig of activeSignals) {
      const key = sig.term.toLowerCase()
      const already = seenCount.get(key) ?? 0
      if (already >= MAX_PER_TERM) continue
      const rx = termRegex(sig.term, true)
      let m
      while ((m = rx.exec(line)) !== null) {
        if ((seenCount.get(key) ?? 0) >= MAX_PER_TERM) break
        const start = m.index
        const end = start + m[0].length
        if (end <= start) break
        let clash = false
        for (let i = start; i < end; i++) {
          if (occupied[i]) { clash = true; break }
        }
        if (clash) continue
        for (let i = start; i < end; i++) occupied[i] = true
        seenCount.set(key, (seenCount.get(key) ?? 0) + 1)
        spans.push({
          start, end, text: m[0], kind: sig.kind, term: sig.term, reason: sig.reason,
          category: sig.category, translation: sig.translation, question: sig.question, isBonus: sig.isBonus,
        })
        totalHighlights++
        const bucket = sig.kind === 'risk' ? foundRisks
          : sig.kind === 'gap' ? foundGaps
            : sig.kind === 'learn' ? foundLearn
              : sig.kind === 'match' ? foundMatched : foundFocused
        const dedupKey = sig.kind === 'risk' && sig.ruleId ? sig.ruleId : key
        if (!bucket.has(dedupKey)) {
          bucket.set(dedupKey, {
            term: m[0], kind: sig.kind, reason: sig.reason, isBonus: sig.isBonus,
            category: sig.category, translation: sig.translation, question: sig.question,
            ...(sig.noteTerm ? { noteTerm: sig.noteTerm } : {}),
          })
        }
      }
    }

    if (!spans.length) return [{ text: line }]
    spans.sort((a, b) => a.start - b.start)
    const segments = []
    let cursor = 0
    for (const sp of spans) {
      if (sp.start > cursor) segments.push({ text: line.slice(cursor, sp.start) })
      segments.push({
        text: sp.text, kind: sp.kind, term: sp.term, reason: sp.reason, isBonus: sp.isBonus,
        category: sp.category, translation: sp.translation, question: sp.question,
      })
      cursor = sp.end
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor) })
    return segments
  }

  const rawBlocks = splitJdBlocks(text)
  const blocks = rawBlocks.map(block => {
    if (block.type === 'list') {
      return { type: 'list', items: block.items.map(item => highlightLine(item)) }
    }
    if (block.type === 'heading') {
      return { type: 'heading', text: block.text }
    }
    return { type: 'paragraph', segments: highlightLine(block.segments ?? block.text) }
  })

  return {
    blocks,
    summary: {
      matched: [...foundMatched.values()],
      focused: [...foundFocused.values()],
      learn: [...foundLearn.values()],
      gaps: [...foundGaps.values()],
      risks: [...foundRisks.values()],
    },
    totalHighlights,
  }
}

export function buildStudyPrompt({ job, term, isBonus = false, matched = [], locale = 'zh' }) {
  const isEn = locale === 'en'
  const company = job?.company || (isEn ? 'the target company' : '目标公司')
  const title = job?.title || (isEn ? 'this role' : '该岗位')
  const known = matched.slice(0, 5).map(m => m.term).join(isEn ? ', ' : '、')
  if (isEn) {
    return [
      `I am preparing to apply for "${company} · ${title}". The job description highlights "${term}" (${isBonus ? 'preferred / bonus skill' : 'core technical requirement'}), which is not yet covered on my resume.`,
      'Please start a structured technical study & interview-prep session:',
      `1) From a senior engineer's perspective, explain the core architecture, trade-offs, and production use cases of "${term}", and why a team like ${company} cares about it;`,
      known ? `2) Bridge "${term}" to what I already know (${known}) so I can speak honestly and thoughtfully about transferable experience in interviews;` : '2) Map out the essential concepts from fundamentals to interview-ready depth;',
      `3) Give me 3 realistic interview deep-dive questions on "${term}" with strong answer frameworks, plus a 3-day hands-on mini-lab / reading list.`,
    ].join('\n')
  }
  return [
    `我正在准备投递「${company} · ${title}」，岗位 JD 中提到了「${term}」${isBonus ? '（加分项）' : '（核心技术要求）'}，但我目前简历中还没有覆盖这块内容。`,
    '请帮我开一个系统的技术调研与学习对话：',
    `1) 用资深工程师视角，通俗讲清楚「${term}」的核心原理、典型生产架构以及为什么 ${company} 这类团队会重点看重它；`,
    known ? `2) 结合我已经熟悉的 ${known}，帮我建立知识迁移类比，说明面试中如何诚实且有深度地聊迁移能力；` : '2) 帮我梳理从入门到面试能讲透的核心概念图谱；',
    `3) 给我 3 个面试官最爱追问的「${term}」实战题 + 参考答题思路，以及一份 3 天可上手的最小动手实验/资料清单。`,
  ].join('\n')
}

export function buildDiligencePrompt({ job, risks = [], matched = [], diligence = [], locale = 'zh' }) {
  const isEn = locale === 'en'
  const company = job?.company || (isEn ? 'the target company' : '目标公司')
  const title = job?.title || (isEn ? 'this role' : '该岗位')
  const location = String(job?.location || '').trim()
  const url = String(job?.url || '').trim()
  const headerMeta = [location, url].filter(Boolean).join(isEn ? ' | ' : ' / ')
  const roleRef = headerMeta ? `${company} · ${title} (${headerMeta})` : `${company} · ${title}`
  const riskWords = risks.map(r => (isEn ? `"${r.term}"` : `「${r.term}」`)).join(isEn ? ', ' : '、')
  const matchWords = matched.slice(0, 5).map(m => m.term).join(isEn ? ', ' : '、')
  const checks = Array.isArray(diligence) ? diligence.map(c => String(c || '').trim()).filter(Boolean).slice(0, 4) : []

  if (isEn) {
    return [
      `Please run live web research and give me a concise pre-application due-diligence brief for "${roleRef}":`,
      `1) Company fundamentals & stability: business model, recent revenue/funding updates, org changes, hiring pace, or layoff signals;`,
      `2) Specific team & role reputation: engineering culture, WLB/on-call intensity, management style, and real candidate/employee feedback;`,
      ...(checks.length
        ? [`3) Cross-check these role-specific diligence items: ${checks.map((c, i) => `(${i + 1}) ${c}`).join('; ')};`]
        : []),
      riskWords
        ? `${checks.length ? '4' : '3'}) The JD includes signals like ${riskWords}—verify the actual workload and give me 3 sharp, tactful reverse-interview questions;`
        : `${checks.length ? '4' : '3'}) Based on this role, give me 3 sharp, tactful reverse-interview questions to verify before accepting an offer;`,
      matchWords
        ? `${checks.length ? '5' : '4'}) With my background in ${matchWords}, assess the role's resume upside and market positioning.`
        : `${checks.length ? '5' : '4'}) Summarize key red flags, unknowns, and whether this team is worth investing interview cycles into.`,
    ].join('\n')
  }

  return [
    `请帮我直接联网调研「${roleRef}」，给一份投递/面试前背调简报（附上关键信息来源与不确定项）：`,
    `1) 公司基本面与稳定性：当前业务重心、营收或最新融资/股东变化、近期组织调整或裁员动态；`,
    `2) 对应部门与岗位口碑：工程文化、加班与 On-Call 强度、绩效/晋升口碑及近期面试体验反馈；`,
    ...(checks.length
      ? [`3) 重点核实以下岗位待查项：${checks.map((c, i) => `(${i + 1}) ${c}`).join('；')}；`]
      : []),
    riskWords
      ? `${checks.length ? '4' : '3'}) 岗位描述中出现了 ${riskWords} 等信号，帮我交叉核实真实工作边界，并给 3 个不冒犯但能问出真相的反问问题；`
      : `${checks.length ? '4' : '3'}) 结合这个岗位帮我准备 3 个在技术终面/HR 面最值得反问的核实问题；`,
    matchWords
      ? `${checks.length ? '5' : '4'}) 我目前匹配的核心方向是 ${matchWords}，综合评估这个岗位的长期履历价值与议价空间。`
      : `${checks.length ? '5' : '4'}) 汇总目前公开信息里的主要风险点、仍待核实的盲区，以及值不值得投入面试精力。`,
  ].join('\n')
}

export function mergeJdRiskItems(intelRiskNotes = [], annotatedRisks = []) {
  const localRisks = Array.isArray(annotatedRisks) ? annotatedRisks : []
  const aiNotes = Array.isArray(intelRiskNotes) ? intelRiskNotes : []

  const locateTermFor = rawTerm => {
    const clean = String(rawTerm || '').trim()
    if (!clean) return ''
    const lower = clean.toLowerCase()
    const exact = localRisks.find(r => (r.noteTerm && r.noteTerm.toLowerCase() === lower) || r.term.toLowerCase() === lower)
    if (exact) return exact.term
    const partial = localRisks.find(r => lower.includes(r.term.toLowerCase()) || r.term.toLowerCase().includes(lower))
    return partial ? partial.term : ''
  }

  const merged = []
  const covered = []
  const isCovered = candidateTerm => {
    const lower = String(candidateTerm || '').trim().toLowerCase()
    if (!lower) return true
    return covered.some(seen => seen === lower || seen.includes(lower) || lower.includes(seen))
  }

  for (const note of aiNotes) {
    const term = String(note?.term || '').trim()
    const translation = String(note?.meaning || note?.translation || '').trim()
    if (!term || !translation) continue
    const locateTerm = locateTermFor(term)
    merged.push({
      term,
      locateTerm,
      translation,
      question: String(note?.question || '').trim(),
      source: 'ai',
    })
    covered.push(term.toLowerCase())
    if (locateTerm) covered.push(locateTerm.toLowerCase())
  }

  for (const r of localRisks) {
    if (r.noteTerm) continue
    if (isCovered(r.term)) continue
    merged.push({
      term: r.term,
      locateTerm: r.term,
      category: r.category,
      translation: r.translation,
      question: r.question || '',
      source: 'rule',
    })
    covered.push(r.term.toLowerCase())
  }

  return merged
}
