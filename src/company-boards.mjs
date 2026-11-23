import { NATIVE_HIRING_CHANNELS, parseNativeHiringUrl } from './native-hiring.mjs'
import { ATS_HIRING_CHANNELS, ATS_MOKA_PROJECTS, mokaProjectSlug } from './ats-hiring.mjs'
import { GLOBAL_HIRING_CHANNELS } from './global-hiring.mjs'

// Shared by browser search, natural-language intake, and official board discovery.
export const MOKA_PROJECTS = Object.freeze({
  deepseek: { org: 'high-flyer', project: '140576', kind: 'social-recruitment' },
  moonshot: { org: 'moonshot', project: '148506', kind: 'apply' },
  stepfun: { org: 'step', project: '94904', kind: 'social-recruitment' },
  ...ATS_MOKA_PROJECTS,
})

const agibot = { provider: 'feishu', company: '智元机器人', companyEn: 'AGIBOT', aliases: ['智元', 'Agirobot'], domain: 'agibot.com', otherDomains: ['agibot.com.cn'], hiringGroup: 'agibot', region: 'cn', tag: '人形机器人与具身智能模型', tagEn: 'Humanoid robots and embodied AI models', keywords: '具身智能 embodied AI 机器人 locomotion 运动控制', tone: 'blue' }

const directory = [
  { provider: 'feishu', slug: 'bytedance', company: '字节跳动', aliases: ['字节'], companyEn: 'ByteDance', domain: 'bytedance.com', region: 'cn', tag: '短视频平台与豆包 AI 助手', tagEn: 'Short video platforms and the Doubao AI assistant', keywords: '抖音 Douyin TikTok Seed 火山引擎 Volcano Engine', host: 'jobs.bytedance.com', tone: 'blue' },
  { provider: 'tencent', slug: 'social', company: '腾讯', companyEn: 'Tencent', domain: 'tencent.com', region: 'cn', tag: '微信、游戏与云服务', tagEn: 'WeChat, games and cloud services', keywords: '混元 Hunyuan 微信 WeChat IEG 腾讯云 Tencent Cloud', host: 'careers.tencent.com', tone: 'indigo' },
  { provider: 'alibaba', slug: 'group', company: '阿里巴巴集团', aliases: ['阿里巴巴', '阿里', 'Alibaba'], companyEn: 'Alibaba Group', domain: 'alibaba.com', region: 'cn', tag: '电子商务与云计算', tagEn: 'E-commerce and cloud computing', keywords: '淘宝 天猫 Taobao Tmall 国际商业', host: 'talent-holding.alibaba.com', tone: 'amber' },
  { provider: 'alibaba', slug: 'aliyun', company: '阿里云', aliases: ['Aliyun'], companyEn: 'Alibaba Cloud', domain: 'aliyun.com', region: 'cn', tag: '云计算与百炼大模型平台', tagEn: 'Cloud computing and Model Studio for AI developers', keywords: '千问 通义 Qwen 飞天 Apsara 百炼 Model Studio', host: 'careers.aliyun.com', tone: 'amber' },
  { provider: 'baidu', slug: 'social', company: '百度', companyEn: 'Baidu', domain: 'baidu.com', region: 'cn', tag: '搜索引擎、AI 云与自动驾驶', tagEn: 'Search, AI cloud services and autonomous driving', keywords: '文心 ERNIE 百度智能云 Apollo Go 萝卜快跑', host: 'talent.baidu.com', tone: 'blue' },
  { provider: 'meituan', slug: 'social', company: '美团', companyEn: 'Meituan', domain: 'meituan.com', region: 'cn', tag: '本地生活服务与即时零售', tagEn: 'Local services and on-demand retail', keywords: '外卖 配送算法 delivery 推荐系统 RecSys', host: 'zhaopin.meituan.com', tone: 'amber' },
  { provider: 'xiaohongshu', slug: 'social', company: '小红书', aliases: ['Xiaohongshu'], companyEn: 'Xiaohongshu (RED)', domain: 'xiaohongshu.com', region: 'cn', tag: '生活兴趣社区与内容电商', tagEn: 'Lifestyle communities and social commerce', keywords: '社区推荐 推荐系统 RecSys REDnote', host: 'job.xiaohongshu.com', tone: 'rose' },
  { provider: 'jd', slug: 'social', company: '京东', aliases: ['jd.com'], companyEn: 'JD.com', domain: 'jd.com', region: 'cn', tag: '线上零售与供应链物流', tagEn: 'Online retail and supply chain logistics', keywords: '言犀 Yanxi 供应链 supply chain', host: 'zhaopin.jd.com', tone: 'rose' },
  { provider: 'netease', slug: 'social', company: '网易', companyEn: 'NetEase', domain: '163.com', region: 'cn', tag: '游戏开发、在线音乐与有道教育', tagEn: 'Games, music streaming and Youdao learning services', keywords: '网易云音乐 Cloud Music 网络游戏 NetEase Games', host: 'hr.163.com', tone: 'slate' },
  { provider: 'bilibili', slug: 'social', company: '哔哩哔哩', aliases: ['B站'], companyEn: 'Bilibili', domain: 'bilibili.com', region: 'cn', tag: '视频创作与弹幕社区', tagEn: 'Video sharing with synchronized on-screen comments', keywords: '视频推荐 推荐系统 RecSys danmaku', host: 'jobs.bilibili.com', tone: 'blue' },
  { provider: 'trip', slug: 'social', company: '携程', aliases: ['Ctrip', 'Trip.com'], companyEn: 'Trip.com Group', domain: 'trip.com', region: 'cn', tag: '酒店、机票与旅行预订', tagEn: 'Hotel, flight and vacation bookings', keywords: 'Ctrip Skyscanner 酒旅预订', host: 'job.ctrip.com', tone: 'indigo' },
  { provider: 'mihoyo', slug: 'social', company: '米哈游', aliases: ['miHoYo', 'HoYoverse'], companyEn: 'miHoYo / HoYoverse', domain: 'mihoyo.com', region: 'cn', tag: '《原神》《崩坏：星穹铁道》等角色扮演游戏', tagEn: 'Role-playing games including Genshin Impact and Honkai: Star Rail', keywords: '图形引擎 graphics rendering 开放世界 open world', host: 'jobs.mihoyo.com', tone: 'indigo' },
  { provider: 'feishu', slug: 'poizon', company: '得物', aliases: ['POIZON', 'Dewu'], companyEn: 'POIZON (Dewu)', domain: 'dewu.com', region: 'cn', tag: '潮流商品交易与真伪鉴别', tagEn: 'Sneaker and streetwear marketplace with authentication', keywords: '潮流电商 电商推荐 RecSys 球鞋 sneakers', host: 'poizon.jobs.feishu.cn', tone: 'teal' },
  { provider: 'feishu', slug: 'zhipu-ai', company: '智谱 AI', aliases: ['智谱', 'Zhipu'], companyEn: 'Zhipu AI', domain: 'zhipuai.cn', region: 'cn', tag: 'GLM 系列模型与开发者平台', tagEn: 'GLM foundation models and developer tools', keywords: 'AutoGLM 智谱清言 Z.ai', host: 'zhipu-ai.jobs.feishu.cn', tone: 'teal' },
  { provider: 'feishu', slug: 'minimax', company: 'MiniMax', aliases: ['稀宇'], companyEn: 'MiniMax', domain: 'minimaxi.com', region: 'cn', tag: '语言、视频与音频生成模型', tagEn: 'Language, video and audio generation models', keywords: '海螺 Hailuo Music Speech', host: 'vrfi1sk8a0.jobs.feishu.cn', tone: 'rose' },
  { provider: 'feishu', slug: '01ai', company: '零一万物', aliases: ['01.AI'], companyEn: '01.AI', domain: '01.ai', region: 'cn', tag: '企业 AI 决策与大模型部署', tagEn: 'AI decision tools and model deployment for enterprises', keywords: 'Yi 零一万物大模型', host: '01ai.jobs.feishu.cn', tone: 'indigo' },
  { provider: 'feishu', slug: 'sensetime', company: '商汤科技', aliases: ['商汤'], companyEn: 'SenseTime', domain: 'sensetime.com', region: 'cn', tag: '计算机视觉与日日新多模态模型', tagEn: 'Computer vision and SenseNova multimodal models', keywords: '自动驾驶 SenseAuto 视觉感知', host: 'sensetime.jobs.feishu.cn', tone: 'slate' },
  { provider: 'feishu', slug: 'nio', company: '蔚来', aliases: ['NIO'], companyEn: 'NIO', domain: 'nio.com', region: 'cn', tag: '智能电动汽车与换电网络', tagEn: 'Electric vehicles and battery swapping networks', keywords: '车端推理 电池换电 battery swap 智能座舱', host: 'nio.jobs.feishu.cn', tone: 'teal' },
  { provider: 'feishu', slug: 'xiaopeng', company: '小鹏汽车', aliases: ['小鹏'], companyEn: 'XPENG', domain: 'xiaopeng.com', region: 'cn', tag: '智能电动汽车与辅助驾驶', tagEn: 'Electric vehicles and driver assistance systems', keywords: 'XNGP 智驾 芯片 自动驾驶 autonomous driving', host: 'xiaopeng.jobs.feishu.cn', tone: 'slate' },
  { provider: 'feishu', slug: 'momenta', company: 'Momenta', companyEn: 'Momenta', domain: 'momenta.ai', region: 'cn', tag: '量产辅助驾驶与无人驾驶系统', tagEn: 'Driver assistance and autonomous driving systems', keywords: '端到端自动驾驶 端侧推理部署 on-device inference', host: 'momenta.jobs.feishu.cn', tone: 'blue' },
  { provider: 'feishu', slug: 'bambulab', company: '拓竹科技', aliases: ['拓竹'], companyEn: 'Bambu Lab', domain: 'bambulab.com', region: 'cn', tag: '桌面 3D 打印机与打印软件', tagEn: 'Desktop 3D printers and printing software', keywords: 'Bambu Studio 切片 slicer FDM', host: 'bambulab.jobs.feishu.cn', tone: 'teal' },
  { provider: 'feishu', slug: 'anker-in', company: '安克创新', aliases: ['安克', 'Anker'], companyEn: 'Anker Innovations', domain: 'anker.com', region: 'cn', tag: '充电设备、家庭储能与智能硬件', tagEn: 'Charging devices, home energy storage and smart hardware', keywords: 'Anker SOLIX eufy soundcore', host: 'anker-in.jobs.feishu.cn', tone: 'blue' },
  // International company boards.
  { provider: 'ashby', slug: 'openai', company: 'OpenAI', domain: 'openai.com', region: 'global', tag: 'ChatGPT 与通用 AI 模型', tagEn: 'ChatGPT and general-purpose AI models', keywords: 'GPT Codex ChatGPT', host: 'jobs.ashbyhq.com/openai', tone: 'slate' },
  { provider: 'greenhouse', slug: 'anthropic', company: 'Anthropic', domain: 'anthropic.com', region: 'global', tag: 'Claude 系列模型与 AI 安全研究', tagEn: 'Claude models and AI safety research', keywords: 'Claude Code 对齐 alignment interpretability 可解释性', host: 'job-boards.greenhouse.io/anthropic', tone: 'amber' },
  { provider: 'greenhouse', slug: 'databricks', company: 'Databricks', domain: 'databricks.com', region: 'global', tag: '湖仓一体的数据与 AI 平台', tagEn: 'Lakehouse platform for data and AI', keywords: 'Spark Delta Lake Lakehouse 湖仓一体', host: 'job-boards.greenhouse.io/databricks', tone: 'rose' },
  { provider: 'greenhouse', slug: 'stripe', company: 'Stripe', domain: 'stripe.com', region: 'global', tag: '企业支付与计费服务', tagEn: 'Payments and billing for businesses', keywords: '金融科技 FinTech 支付基础设施', host: 'job-boards.greenhouse.io/stripe', tone: 'blue' },
  { provider: 'greenhouse', slug: 'cloudflare', company: 'Cloudflare', domain: 'cloudflare.com', region: 'global', tag: '网络安全、内容分发与边缘计算', tagEn: 'Network security, content delivery and edge computing', keywords: 'CDN Workers AI 边缘云 edge cloud', host: 'job-boards.greenhouse.io/cloudflare', tone: 'amber' },
  { provider: 'greenhouse', slug: 'airbnb', company: 'Airbnb', domain: 'airbnb.com', region: 'global', tag: '短租住宿与旅行体验预订', tagEn: 'Marketplace for stays and travel experiences', keywords: '旅行住宿 服务平台 marketplace', host: 'job-boards.greenhouse.io/airbnb', tone: 'rose' },
  { provider: 'greenhouse', slug: 'doordashusa', company: 'DoorDash', domain: 'doordash.com', region: 'global', tag: '餐饮外卖与本地零售配送', tagEn: 'Restaurant and retail delivery', keywords: '本地商业 商家配送 推荐系统 RecSys', host: 'job-boards.greenhouse.io/doordashusa', tone: 'rose' },
  { provider: 'greenhouse', slug: 'coinbase', company: 'Coinbase', domain: 'coinbase.com', region: 'global', tag: '加密资产交易与托管', tagEn: 'Crypto trading and custody', keywords: '加密货币 cryptocurrency 区块链 blockchain', host: 'job-boards.greenhouse.io/coinbase', tone: 'blue' },
  { provider: 'ashby', slug: 'snowflake', company: 'Snowflake', domain: 'snowflake.com', region: 'global', tag: '云数据仓库与企业数据分析', tagEn: 'Cloud data warehousing and analytics', keywords: 'AI Data Cloud 分布式数据库 distributed database', host: 'jobs.ashbyhq.com/snowflake', tone: 'blue' },
  { provider: 'greenhouse', slug: 'datadog', company: 'Datadog', domain: 'datadoghq.com', region: 'global', tag: '云应用监控与安全平台', tagEn: 'Cloud monitoring and security', keywords: '可观测性 observability APM 日志 logs', host: 'job-boards.greenhouse.io/datadog', tone: 'indigo' },
  { provider: 'greenhouse', slug: 'mongodb', company: 'MongoDB', domain: 'mongodb.com', region: 'global', tag: '文档数据库与 Atlas 云服务', tagEn: 'Document databases and the Atlas cloud platform', keywords: 'Atlas NoSQL 文档数据库', host: 'job-boards.greenhouse.io/mongodb', tone: 'teal' },
  { provider: 'greenhouse', slug: 'gitlab', company: 'GitLab', domain: 'gitlab.com', region: 'global', tag: '代码托管与持续交付平台', tagEn: 'Source code management and continuous delivery', keywords: 'DevSecOps CI/CD 持续集成', host: 'job-boards.greenhouse.io/gitlab', tone: 'amber' },
  { provider: 'greenhouse', slug: 'waymo', company: 'Waymo', domain: 'waymo.com', region: 'global', tag: '自动驾驶技术与无人驾驶出行服务', tagEn: 'Autonomous driving and ride-hailing', keywords: 'Waymo Driver 自动驾驶 autonomous driving robotaxi', host: 'job-boards.greenhouse.io/waymo', tone: 'teal' },
  { provider: 'greenhouse', slug: 'reddit', company: 'Reddit', domain: 'reddit.com', region: 'global', tag: '按兴趣组织的讨论社区', tagEn: 'Interest-based discussion communities', keywords: '社区搜索 内容推荐 推荐系统 RecSys', host: 'job-boards.greenhouse.io/reddit', tone: 'rose' },
  { provider: 'greenhouse', slug: 'pinterest', company: 'Pinterest', domain: 'pinterest.com', region: 'global', tag: '视觉搜索与灵感收藏', tagEn: 'Visual search and inspiration boards', keywords: '视觉发现 图片检索 推荐系统 RecSys', host: 'job-boards.greenhouse.io/pinterest', tone: 'rose' },
  { provider: 'lever', slug: 'spotify', company: 'Spotify', domain: 'spotify.com', region: 'global', tag: '音乐、播客与有声书流媒体', tagEn: 'Music, podcast and audiobook streaming', keywords: '音频推荐 推荐系统 personalization RecSys', host: 'jobs.lever.co/spotify', tone: 'teal' },
  { provider: 'ashby', slug: 'cursor', company: 'Cursor', domain: 'cursor.com', region: 'global', tag: 'AI 代码编辑器与编程智能体', tagEn: 'AI code editor and coding agents', keywords: 'AI coding code editor 编程助手', host: 'jobs.ashbyhq.com/cursor', tone: 'indigo' },
  { provider: 'greenhouse', slug: 'xai', company: 'xAI', domain: 'x.ai', region: 'global', tag: 'Grok 系列模型与 AI 助手', tagEn: 'Grok models and AI assistant', keywords: 'Grok 生成式 AI', host: 'job-boards.greenhouse.io/xai', tone: 'slate' },
  { provider: 'greenhouse', slug: 'scaleai', company: 'Scale AI', domain: 'scale.com', region: 'global', tag: 'AI 训练数据与模型评测', tagEn: 'AI training data and model evaluation', keywords: '数据标注 data labeling evaluation 评测', host: 'job-boards.greenhouse.io/scaleai', tone: 'blue' },
  { provider: 'greenhouse', slug: 'vercel', company: 'Vercel', domain: 'vercel.com', region: 'global', tag: 'Web 应用部署与 AI 开发工具', tagEn: 'Web app deployment and AI developer tools', keywords: 'Next.js AI SDK v0', host: 'job-boards.greenhouse.io/vercel', tone: 'slate' },
  { provider: 'greenhouse', slug: 'figma', company: 'Figma', domain: 'figma.com', region: 'global', tag: '协作式界面设计与原型工具', tagEn: 'Collaborative interface design and prototyping', keywords: 'Figma Design FigJam prototyping 原型', host: 'job-boards.greenhouse.io/figma', tone: 'rose' },
  { provider: 'ashby', slug: 'linear', company: 'Linear', domain: 'linear.app', region: 'global', tag: '产品路线图与研发任务管理', tagEn: 'Product roadmaps and issue tracking', keywords: 'issue tracker 项目管理', host: 'jobs.ashbyhq.com/linear', tone: 'indigo' },
  { provider: 'ashby', slug: 'notion', company: 'Notion', domain: 'notion.so', region: 'global', tag: '团队文档与知识库', tagEn: 'Collaborative docs and team wikis', keywords: 'Notion AI workspace 项目管理 project management', host: 'jobs.ashbyhq.com/notion', tone: 'slate' },
  { provider: 'ashby', slug: 'perplexity', company: 'Perplexity', domain: 'perplexity.ai', region: 'global', tag: '附带来源的 AI 搜索引擎', tagEn: 'AI search with cited answers', keywords: 'AI search 搜索 引用 citations', host: 'jobs.ashbyhq.com/perplexity', tone: 'teal' },
  { provider: 'ashby', slug: 'cohere', company: 'Cohere', domain: 'cohere.com', region: 'global', tag: '企业语言模型与语义检索', tagEn: 'Enterprise language models and semantic search', keywords: 'RAG retrieval reranking 检索增强生成', host: 'jobs.ashbyhq.com/cohere', tone: 'teal' },
  { provider: 'ashby', slug: 'elevenlabs', company: 'ElevenLabs', domain: 'elevenlabs.io', region: 'global', tag: 'AI 语音生成与语音智能体', tagEn: 'AI voice generation and voice agents', keywords: 'TTS STT 语音合成 语音识别 text to speech', host: 'jobs.ashbyhq.com/elevenlabs', tone: 'slate' },
  { provider: 'ashby', slug: 'cognition', company: 'Cognition', domain: 'cognition.ai', region: 'global', tag: '软件工程智能体 Devin', tagEn: 'Devin software engineering agent', keywords: 'AI coding coding agent 软件开发', host: 'jobs.ashbyhq.com/cognition', tone: 'indigo' },
  { provider: 'ashby', slug: 'supabase', company: 'Supabase', domain: 'supabase.com', region: 'global', tag: '基于 Postgres 的应用后端', tagEn: 'Postgres-based application backend', keywords: 'PostgreSQL 数据库 backend as a service', host: 'jobs.ashbyhq.com/supabase', tone: 'teal' },
  { provider: 'feishu', slug: 'infinigence__infinigence', company: '无问芯穹', companyEn: 'Infinigence AI', aliases: ['Infinigence'], domain: 'infinigence-ai.com', region: 'cn', tag: '面向异构芯片的 AI 算力平台', tagEn: 'AI computing platforms for heterogeneous chips', keywords: 'Infini-AI 异构算力 异构推理 推理优化 AI 编译器 heterogeneous inference compiler', host: 'infinigence.jobs.feishu.cn/infinigence', tone: 'indigo' },
  { provider: 'feishu', slug: 'modelbest__career', company: '面壁智能', companyEn: 'ModelBest', aliases: ['面壁', 'Model Best'], domain: 'modelbest.cn', region: 'cn', tag: 'MiniCPM 端侧语言与多模态模型', tagEn: 'MiniCPM on-device language and multimodal models', keywords: '端侧大模型推理 内存带宽 内存优化 CPU GPU NPU on-device inference memory bandwidth', host: 'modelbest.jobs.feishu.cn/career', tone: 'teal' },
  { provider: 'feishu', slug: 'aisphere__join', company: '爱诗科技', companyEn: 'AIsphere / PixVerse', aliases: ['爱诗', 'AIsphere', 'PixVerse'], domain: 'aishiai.com', region: 'cn', tag: 'PixVerse 视频生成与创作工具', tagEn: 'PixVerse video generation and production tools', keywords: '视频生成 GPU 调度 训练推理混部 video generation GPU scheduling', host: 'aisphere.jobs.feishu.cn/join', tone: 'rose' },
  { ...agibot, slug: 'agirobot__socialrecruitment', hiringScope: 'experienced', host: 'agirobot.jobs.feishu.cn/socialrecruitment' },
  { ...agibot, slug: 'agirobot__campusrecruitment', hiringScope: 'campus', host: 'agirobot.jobs.feishu.cn/campusrecruitment' },
  { provider: 'greenhouse', slug: 'microsoftcorporation', company: 'Microsoft AI', companyEn: 'Microsoft AI', aliases: ['微软 AI', '微软AI', 'MicrosoftAI'], domain: 'microsoft.ai', region: 'global', tag: 'MAI 系列基础模型', tagEn: 'MAI foundation models', keywords: 'Copilot 推理系统 算力调度 inference systems compute scheduling', host: 'job-boards.greenhouse.io/microsoftcorporation', tone: 'blue' },
  { provider: 'greenhouse', slug: 'coreweave', company: 'CoreWeave', domain: 'coreweave.com', region: 'global', tag: '面向大规模 AI 训练与推理的 GPU 云', tagEn: 'GPU cloud for large-scale training and inference', keywords: 'Kubernetes 集群编排 cluster orchestration GPU 云', host: 'job-boards.greenhouse.io/coreweave', tone: 'indigo' },
  { provider: 'greenhouse', slug: 'nebius', company: 'Nebius', domain: 'nebius.com', region: 'global', tag: 'GPU 云与 Token Factory 推理服务', tagEn: 'GPU cloud and Token Factory inference', keywords: 'HPC 高性能计算 集群 cluster', host: 'job-boards.greenhouse.io/nebius', tone: 'teal' },
  { provider: 'ashby', slug: 'lambda', company: 'Lambda', aliases: ['Lambda Labs'], domain: 'lambda.com', region: 'global', tag: '云端 GPU 实例与专用超算集群', tagEn: 'Cloud GPUs and dedicated supercomputing clusters', keywords: 'GPU 云 资源调度 scheduling 控制面 control plane', host: 'jobs.ashbyhq.com/lambda', tone: 'indigo' },
  { provider: 'ashby', slug: 'baseten', company: 'Baseten', domain: 'baseten.co', region: 'global', tag: '自定义模型部署与托管推理', tagEn: 'Custom model deployment and managed inference', keywords: 'Truss 模型服务 model serving Kubernetes', host: 'jobs.ashbyhq.com/baseten', tone: 'teal' },
  { provider: 'ashby', slug: 'fireworks', company: 'Fireworks AI', aliases: ['Fireworks'], domain: 'fireworks.ai', region: 'global', tag: '开放模型推理与定制训练', tagEn: 'Inference and custom training for open models', keywords: '低精度内核 量化 多卡推理 low-precision kernels quantization multi-GPU inference', host: 'jobs.ashbyhq.com/fireworks', tone: 'rose' },
  { provider: 'ashby', slug: 'crusoe', company: 'Crusoe', domain: 'crusoe.ai', region: 'global', tag: 'AI 数据中心建设与 GPU 云', tagEn: 'AI data centers and GPU cloud', keywords: 'GPU 云 推理系统 inference CUDA', host: 'jobs.ashbyhq.com/crusoe', tone: 'amber' },
  { provider: 'ashby', slug: 'radixark', company: 'RadixArk', aliases: ['Radix Ark'], domain: 'radixark.com', region: 'global', tag: 'SGLang 推理与 Miles 强化学习平台', tagEn: 'SGLang inference and Miles reinforcement learning', keywords: 'KV Cache 分布式推理 distributed inference 强化学习 reinforcement learning', host: 'jobs.ashbyhq.com/radixark', tone: 'slate' },
  { provider: 'ashby', slug: 'modal', company: 'Modal', aliases: ['Modal Labs'], domain: 'modal.com', region: 'global', tag: '按需 GPU 计算与智能体沙箱', tagEn: 'On-demand GPU compute and agent sandboxes', keywords: '无服务器计算 serverless GPU 容器 推理运行时 inference runtime RDMA', host: 'jobs.ashbyhq.com/modal', tone: 'teal' },
  { provider: 'ashby', slug: 'cerebras', company: 'Cerebras', aliases: ['Cerebras Systems'], domain: 'cerebras.ai', region: 'global', tag: '晶圆级 AI 芯片与推理系统', tagEn: 'Wafer-scale AI chips and inference systems', keywords: 'WSE 晶圆 wafer-scale 推理加速 inference', host: 'jobs.ashbyhq.com/cerebras', tone: 'amber' },
  { provider: 'greenhouse', slug: 'togetherai', company: 'Together AI', aliases: ['TogetherAI'], domain: 'together.ai', region: 'global', tag: '开放模型云平台与 GPU 集群', tagEn: 'Cloud for open models and GPU clusters', keywords: '分布式训练 distributed training 推理基础设施 inference infrastructure', host: 'job-boards.greenhouse.io/togetherai', tone: 'blue' },
  { provider: 'ashby', slug: 'mistral.ai', company: 'Mistral AI', aliases: ['Mistral'], domain: 'mistral.ai', region: 'global', tag: '开放权重模型与企业 AI 平台', tagEn: 'Open-weight models and enterprise AI software', keywords: 'Le Chat 开放权重 open-weight 分布式训练 distributed training', host: 'jobs.ashbyhq.com/mistral.ai', tone: 'amber' },
  { provider: 'moka', slug: 'deepseek', company: 'DeepSeek', companyEn: 'DeepSeek', aliases: ['深度求索', 'Deep Seek'], domain: 'deepseek.com', region: 'cn', tag: '开放权重的语言与推理模型', tagEn: 'Open-weight language and reasoning models', keywords: '超算集群 GPU 集群调度 训练推理框架 集合通信 GPU clusters collectives training inference', host: 'talent.deepseek.com', tone: 'blue' },
  { provider: 'moka', slug: 'moonshot', company: '月之暗面', companyEn: 'Moonshot AI / Kimi', aliases: ['Kimi', 'Moonshot', 'Moonshot AI'], domain: 'kimi.com', otherDomains: ['moonshot.cn'], region: 'cn', tag: 'Kimi 多模态模型与 AI 助手', tagEn: 'Kimi multimodal models and AI assistant', keywords: 'Kimi 内核工程 模型系统协同设计 kernel engineering model systems', host: 'careers.kimi.com', tone: 'slate' },
  { provider: 'moka', slug: 'stepfun', company: '阶跃星辰', companyEn: 'StepFun', aliases: ['阶跃', 'Step Fun'], domain: 'stepfun.com', region: 'cn', tag: 'Step 系列大模型与语音模型', tagEn: 'Step foundation models and speech models', keywords: '多模态 云原生平台 推理优化 cloud native inference', host: 'app.mokahr.com/social-recruitment/step/94904', tone: 'indigo' },
  { provider: 'ashby', slug: 'inferact', company: 'Inferact', domain: 'inferact.ai', region: 'global', tag: '基于 vLLM 的生产级推理平台', tagEn: 'Production inference platform built on vLLM', keywords: 'vLLM 推理引擎 GPU 性能 GPU kernel inference engine', host: 'jobs.ashbyhq.com/inferact', tone: 'teal' },
]

const hiringDirectory = { ...NATIVE_HIRING_CHANNELS, ...ATS_HIRING_CHANNELS, ...GLOBAL_HIRING_CHANNELS }
export const CURATED_BOARDS = directory.flatMap(board => {
  const key = board.provider + ':' + board.slug
  const channels = hiringDirectory[key]
  if (!channels) return [board]
  return ['all', 'experienced', 'campus'].filter(scope => channels[scope]).map(hiringScope => ({
    ...board, ...channels[hiringScope], hiringScope, hiringGroup: key,
    ...(channels.manualHiring && { manualHiring: channels.manualHiring }),
  }))
})

const providers = new Set(CURATED_BOARDS.map(board => board.provider))
const boardsById = new Map(CURATED_BOARDS.map(board => [board.provider + ':' + board.slug.toLowerCase(), board]))
// A shared ATS homepage can represent several filters. Only distinct, verified URLs select a filter.
const entrances = CURATED_BOARDS.flatMap(board => [board.host, ...(board.entranceUrls || [])].map(link => {
  const url = new URL(link.includes('://') ? link : 'https://' + link)
  return { board, url, specificity: url.pathname.length + url.search.length + url.hash.length }
})).sort((a, b) => b.specificity - a.specificity)

export function matchHiringEntrance(raw) {
  const url = URL.parse(raw)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const native = parseNativeHiringUrl(url)
  if (native) return boardsById.get(native.provider + ':' + native.slug) || null
  // This Moka project publishes mixed recruiting types under a single URL.
  if (url.hostname === 'app.mokahr.com' && /^\/(?:social-recruitment|apply)\/high-flyer\/140576\/?$/u.test(url.pathname))
    return boardsById.get('moka:deepseek')
  const path = url.pathname.replace(/\/$/u, '') + '/'
  for (const entry of entrances) {
    const target = entry.url
    if (target.host !== url.host || !path.startsWith(target.pathname.replace(/\/$/u, '') + '/')) continue
    if (target.hash && target.hash !== url.hash) continue
    if ([...target.searchParams].some(([key, value]) => !url.searchParams.getAll(key).includes(value))) continue
    return entry.board
  }
  return null
}

const channelGroups = new Map()
for (const board of CURATED_BOARDS) {
  if (!board.hiringGroup) continue
  if (!channelGroups.has(board.hiringGroup)) channelGroups.set(board.hiringGroup, [])
  channelGroups.get(board.hiringGroup).push(board)
}

export function companyBoardChannels(board) {
  const preset = findCompanyBoard(board.provider, board.slug) || board
  return channelGroups.get(preset.hiringGroup) || [preset]
}

// Put the default hiring channel first in each company's directory entry.
export const CURATED_COMPANIES = CURATED_BOARDS.filter(board => companyBoardChannels(board)[0] === board)

export function companyHiringBoards(board, scopes = []) {
  const channels = companyBoardChannels(board)
  if (!scopes.length) return [channels[0]]
  if (channels.length === 1 && !channels[0].hiringScope) return channels
  return channels.filter(channel => scopes.includes(channel.hiringScope))
}

export function hiringScopesFromText(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  const scopes = new Set()
  const excluded = new Set()
  const only = new Set()
  const terms = /社会招聘|社招|有(?:工作|行业)经验|\bexperienced(?:[- ](?:hire|professional|role)s?)?|mid[- ]career|lateral hir(?:e|es|ing)|校园招聘|校招|应届(?:生|毕业生)?|campus(?:[- ](?:recruitment|hiring|hires?|jobs?|roles?))?|new[- ]grad(?:uate)?s?|graduate (?:program(?:me)?s?|roles?|jobs?|recruitment)|university (?:hir(?:e|es|ing)|recruit(?:ing|ment))|early[- ]careers?/gu
  const mentions = [...value.matchAll(terms)]
  const ignored = new Set()
  // In “把校招换成社招” and “switch from campus to experienced”, the first mention is the old channel.
  for (let index = 1; index < mentions.length; index++) {
    const from = mentions[index - 1]
    const to = mentions[index]
    const before = value.slice(0, from.index).split(/[，,。；;!！?？]/u).at(-1)
    const between = value.slice(from.index + from[0].length, to.index)
    const zhSwitch = /(?:换|改|切|转)(?:换)?(?:成|到|至|为|回)\s*(?:只看|只订阅)?\s*$/u.test(between)
    const enSwitch = /\b(?:switch|change|move|replace|swap|from)\b/u.test(before)
      && /^(?:[ -]*(?:hires?|hiring|jobs?|roles?|recruitment|positions?|channel|board|portal))*\s+(?:to|with|for)\s+(?:the\s+)?$/u.test(between)
    if (!zhSwitch && !enSwitch) continue
    const noSwitch = /(?:不要|不用|不想|别|不要再)(?:(?:把|将|从)[^，。；,;]{0,35})?\s*$/u.test(before)
      || /(?:不要|不用|不想|别|不能|不)(?:换|改|切|转)/u.test(between)
      || /\b(?:do not|don['’]t|never)\s+(?:switch|change|move|replace|swap)\b/u.test(before)
    ignored.add(noSwitch ? to : from)
  }
  let lastExclusiveEnd = -1
  for (const match of mentions) {
    if (ignored.has(match)) continue
    const scope = /^(?:社会招聘|社招|有|experienced|mid|lateral)/u.test(match[0]) ? 'experienced' : 'campus'
    const before = value.slice(0, match.index)
    const after = value.slice(match.index + match[0].length)
    const negative = /(?:不要|不想(?:看|找|要)?|不(?:看|含|要|走|考虑|接受|需要)|排除|除了?|非|跳过|忽略|不是|并非|\b(?:no|not|exclude|excluding|skip|without|rather than|instead of|don['’]t want|do not want|not interested in)(?: any)?[ -]+|\bnon-)\s*(?:的)?\s*$/u.test(before) ||
      /^(?:岗位|入口|机会)?\s*(?:不要(?!再?[改换切转])|排除|免谈)/u.test(after)
    if (negative) excluded.add(scope)
    else {
      scopes.add(scope)
      const exclusive = /(?:(?:只|仅)(?:想|要|订阅|关注|看|找)*|\bonly(?: (?:want|seeking|include|look for))?)\s*$/u.test(before) || /^\s+(?:roles?\s+|jobs?\s+)?only\b/u.test(after)
      const joined = lastExclusiveEnd >= 0 && /^\s*(?:和|与|及|或|、|\/|and|or)\s*$/u.test(value.slice(lastExclusiveEnd, match.index))
      if (exclusive || joined) {
        only.add(scope)
        lastExclusiveEnd = match.index + match[0].length
      }
    }
  }
  if (!scopes.size && excluded.size === 1) return [excluded.has('campus') ? 'experienced' : 'campus']
  return [...(only.size ? only : scopes)].filter(scope => !excluded.has(scope))
}

// Discovery may return a homepage, a precise ATS URL, or an outdated model hint.
export function resolveNamedHiringBoard(board, rawUrl, hint, intent) {
  const channels = companyBoardChannels(board)
  const scopes = hiringScopesFromText(intent)
  const allowed = scopes.length ? companyHiringBoards(board, scopes) : channels
  const direct = matchHiringEntrance(rawUrl)
  const hinted = hint && findCompanyBoard(hint.provider, hint.slug)
  // A company-wide entrance such as an Ashby tenant URL cannot override the selected filter.
  if (direct?.hiringScope !== 'all' && allowed.includes(direct)) return direct
  if (allowed.includes(hinted)) return hinted
  return allowed[0] ?? null
}

export function overlappingHiringBoards(first, second) {
  const a = findCompanyBoard(first.provider, first.slug)
  const b = findCompanyBoard(second.provider, second.slug)
  return Boolean(a && b && a !== b && a.hiringGroup && a.hiringGroup === b.hiringGroup &&
    (a.hiringScope === 'all' || b.hiringScope === 'all'))
}

export function mergeSearchBoards(existing, proposed, replacedIds = []) {
  const key = board => board.provider + ':' + board.slug.toLowerCase()
  const additions = new Map(proposed.map(board => [key(board), board]))
  const groups = new Set(proposed.map(board => findCompanyBoard(board.provider, board.slug)?.hiringGroup).filter(Boolean))
  const replaced = new Set(replacedIds)
  const retained = existing.filter(board => !replaced.has(key(board)) || !groups.has(findCompanyBoard(board.provider, board.slug)?.hiringGroup))
  const result = new Map(retained.map(board => [key(board), board]))
  for (const [id, board] of additions) {
    for (const [oldId, old] of result) if (overlappingHiringBoards(board, old)) result.delete(oldId)
    result.set(id, board)
  }
  return [...result.values()]
}

export function isValidBoardSlug(provider, slug) {
  if (!providers.has(provider) || typeof slug !== 'string' || !slug.length || slug.length > 100) return false
  if (provider === 'moka') return boardsById.has('moka:' + slug.toLowerCase()) || Object.hasOwn(MOKA_PROJECTS, mokaProjectSlug(slug))
  if (provider === 'ashby') return /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/i.test(slug)
  return /^[a-z0-9][a-z0-9_-]*$/i.test(slug)
}

export function findCompanyBoard(provider, slug) {
  return typeof slug === 'string' ? boardsById.get(provider + ':' + slug.toLowerCase()) ?? null : null
}

// Directory changes are resolved for future scans; completed applications retain their original IDs.
const replacedSubscriptions = new Map(directory.flatMap(board => {
  const key = board.provider + ':' + board.slug
  const first = channelGroups.get(key)?.[0]
  return first && !boardsById.has(key) ? [[key, first]] : []
}))

export function currentSubscription(board) {
  return replacedSubscriptions.get(board.provider + ':' + String(board.slug).toLowerCase()) || board
}

export function boardPosition(board, locale) {
  return locale === 'en' ? board.tagEn : board.tag
}

export function boardSearchText(board) {
  const channel = board.hiringScope === 'campus' ? '校园招聘 校招 应届 campus recruiting campus hiring new grad'
    : board.hiringScope === 'experienced' ? '社会招聘 社招 experienced hiring experienced hire mid-career' : ''
  return [board.company, board.companyEn, ...(board.aliases || []), board.slug, board.tag, board.tagEn, board.keywords, channel, board.domain, board.host]
    .filter(Boolean).join(' ').normalize('NFKC').toLowerCase()
}

function aliasPattern(alias) {
  // Adjacent Chinese words need no space; don't match "Modal" inside "multimodal".
  const value = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const left = /^[a-z0-9]/i.test(alias) ? '(?<![a-z0-9_])' : ''
  const right = /[a-z0-9]$/i.test(alias) ? '(?![a-z0-9_])' : ''
  return new RegExp(left + value + right, 'giu')
}

const companyNames = CURATED_COMPANIES.map(board => {
  const names = [board.company, board.companyEn, ...(board.aliases || [])].filter(Boolean)
  return { board, patterns: [...new Set(names)].map(aliasPattern) }
})

export function namedCompanyRequests(text) {
  const value = String(text ?? '').normalize('NFKC')
    .replace(/\b(?:aws lambda|amazon lambda|lambda (?:functions?|expressions?)|multi[- ]modal|modal dialogs?|linear (?:algebra|regression))\b/giu, ' ')
  // A longer name wins at the same start (Alibaba Cloud vs Alibaba).
  const hits = []
  for (const {board, patterns} of companyNames) {
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        hits.push({ board, start: match.index, end: match.index + match[0].length })
      }
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  let end = -1
  const mentions = hits.filter(hit => {
    if (hit.start < end) return false
    end = hit.end
    return true
  })
  const scopes = hiringScopesFromText(value)
  return mentions.map((hit, index) => {
    let requested = scopes
    if (mentions.length > 1) {
      const after = value.slice(hit.end, mentions[index + 1]?.start).split(/[，,。；;]/u)[0]
      const before = value.slice(mentions[index - 1]?.end ?? 0, hit.start).split(/[，,。；;]/u).at(-1)
      const local = hiringScopesFromText(after)
      requested = local.length ? local : hiringScopesFromText(before)
      if (!requested.length) requested = scopes
    }
    return { board: hit.board, scopes: requested }
  })
}

export function findNamedCompanyBoards(text) {
  return [...new Set(namedCompanyRequests(text).flatMap(({ board, scopes }) => companyHiringBoards(board, scopes)))]
}

function sourceFor(provider, slug) {
  if (!isValidBoardSlug(provider, slug)) return null
  const board = findCompanyBoard(provider, slug)
  return board ? { provider, slug: board.slug, company: board.company, domain: board.domain }
    : { provider, slug, company: slug }
}

const publicTenantPaths = new Map([
  ['job-boards.greenhouse.io', ['greenhouse', []]], ['boards.greenhouse.io', ['greenhouse', []]],
  ['boards-api.greenhouse.io', ['greenhouse', ['v1', 'boards']]],
  ['jobs.ashbyhq.com', ['ashby', []]], ['api.ashbyhq.com', ['ashby', ['posting-api', 'job-board']]],
  ['jobs.lever.co', ['lever', []]], ['api.lever.co', ['lever', ['v0', 'postings']]],
])

export function parseBoardInput(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const keyed = /^([a-z]+):([^/\s]+)$/i.exec(value)
  if (keyed) return sourceFor(keyed[1].toLowerCase(), keyed[2])
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.\-]*:/i.test(value) ? value : 'https://' + value)
  } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  if ((host === 'campus-talent.alibaba.com' && !parseNativeHiringUrl(url)) ||
      (host === 'zhaopin.meituan.com' && /^\/web\/position\/detail(?:\/|$)/u.test(url.pathname))) return null
  const entrance = matchHiringEntrance(url.href)
  if (entrance) return sourceFor(entrance.provider, entrance.slug)
  const hosted = publicTenantPaths.get(host)
  if (hosted) {
    const [provider, prefix] = hosted
    return prefix.every((part, i) => parts[i] === part) ? sourceFor(provider, parts[prefix.length]) : null
  }
  if (host === 'app.mokahr.com') {
    const [kind, org, project] = parts
    const found = Object.entries(MOKA_PROJECTS).find(([, site]) =>
      site.org === org && site.project === project && (kind === site.kind || kind === 'apply'))
    return found ? sourceFor('moka', found[0]) : null
  }
  if (host.endsWith('.jobs.feishu.cn')) {
    const tenant = host.slice(0, -'.jobs.feishu.cn'.length)
    if (!isValidBoardSlug('feishu', tenant)) return null
    if (tenant === 'vrfi1sk8a0') return sourceFor('feishu', 'minimax')
    if (tenant === 'zhipu-ai') return sourceFor('feishu', 'zhipu-ai')
    const site = parts[0] && !['position', 's', 'm', 'referral'].includes(parts[0]) ? parts[0] : ''
    if (!site) {
      const board = CURATED_BOARDS.find(b => b.provider === 'feishu' && b.host.split('/')[0] === host)
      if (board) return sourceFor(board.provider, board.slug)
    }
    return sourceFor('feishu', site ? tenant + '__' + site : tenant)
  }
  // Host-only portals have a fixed company; many use deep SPA job paths.
  if (host === 'talent.alibaba.com') return sourceFor('alibaba', 'group')
  // Official company and careers sites can link out to an ATS on a separate domain.
  const root = host.replace(/^(?:www|careers|jobs|talent)\./, '')
  const official = CURATED_BOARDS.find(b => root === b.domain || b.otherDomains?.includes(root))
  return official ? sourceFor(official.provider, official.slug) : null
}
