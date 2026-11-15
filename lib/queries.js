// 纯函数查询层：不碰 IO、不碰框架。插件 Host 半与 MCP server 共用这一份实现。
import {
  people,
  quotes,
  peopleByName,
  peopleByQid,
  normalizeText,
  normalizeWork,
  stats,
} from "./corpus.js"

/* ───────────────────────── 确定性随机 ───────────────────────── */

/** 字符串 → 32 位种子（FNV-1a）。 */
function hashSeed(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** mulberry32：小而稳的可重放 PRNG。 */
function makeRng(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ───────────────────────── 基础查询 ───────────────────────── */

/** 所有可展示的名句（默认排除"误传"样本）。 */
export function listQuotes(filter = {}) {
  const { author, topic, era, mood, domain, includeDisputed = false } = filter
  return quotes.filter((q) => {
    if (!includeDisputed && q.kind !== "quote") return false
    if (author && q.author !== author && q.author_qid !== author) return false
    if (topic && !q.topics.includes(topic)) return false
    if (era && q.era !== era) return false
    if (mood && q.mood !== mood) return false
    if (domain && !q.domain.includes(domain)) return false
    return true
  })
}

/** 人物列表，可按时代过滤。 */
export function listPeople(filter = {}) {
  const { era } = filter
  return people
    .filter((p) => !era || p.era === era)
    .map((p) => ({
      qid: p.qid,
      name: p.name_zh,
      name_en: p.name_en,
      birth: p.birth_year,
      death: p.death_year,
      era: p.era,
      roles: p.roles,
      works: p.works,
      description: p.description_zh ?? p.description_en ?? null,
      wikipedia_zh: p.wikipedia_zh,
      quote_count: quotes.filter((q) => q.author_qid === p.qid && q.kind === "quote").length,
    }))
}

/** 按姓名取人物（中文名 / Q-id 都可）。 */
export function findPerson(nameOrQid) {
  if (!nameOrQid) return null
  const byQid = peopleByQid.get(nameOrQid)
  if (byQid) return byQid
  const byName = peopleByName.get(nameOrQid)
  if (byName) return byName
  // 宽松匹配：包含关系
  return (
    people.find((p) => p.name_zh.includes(nameOrQid)) ??
    people.find((p) => (p.name_en ?? "").toLowerCase() === String(nameOrQid).toLowerCase()) ??
    null
  )
}

/** 某人的全部名句。 */
export function quotesByPerson(nameOrQid) {
  const person = findPerson(nameOrQid)
  if (!person) return []
  return quotes.filter((q) => q.author_qid === person.qid && q.kind === "quote")
}

/** 人物生平档案：结构化生平 + 代表作 + 该人物名句。 */
export function biography(nameOrQid) {
  const person = findPerson(nameOrQid)
  if (!person) return null
  const own = quotesByPerson(person.qid)
  // 代表作清单用简称（"定风波"），语料用全名（"定风波·莫听穿林打叶声"），
  // 靠 work_base 对齐，再把两边合并成一份带名句的作品表。
  const worksDetail = []
  const seenBases = new Set()
  for (const name of person.works ?? []) {
    const base = normalizeWork(name)
    if (seenBases.has(base)) continue
    seenBases.add(base)
    const items = own.filter((q) => normalizeWork(q.work) === base)
    worksDetail.push({ name, base, quote_count: items.length, quotes: items })
  }
  for (const quote of own) {
    const base = normalizeWork(quote.work)
    if (seenBases.has(base)) continue
    seenBases.add(base)
    worksDetail.push({
      name: quote.work,
      base,
      quote_count: 1,
      quotes: [quote],
    })
  }
  return {
    qid: person.qid,
    name: person.name_zh,
    name_en: person.name_en,
    birth: person.birth_year,
    death: person.death_year,
    birth_precision: person.birth_precision,
    death_precision: person.death_precision,
    era: person.era,
    roles: person.roles,
    works: person.works,
    works_detail: worksDetail,
    description: person.description_zh ?? person.description_en ?? null,
    wikipedia_zh: person.wikipedia_zh,
    wikipedia_en: person.wikipedia_en,
    quotes: quotesByPerson(person.qid),
    source: "Wikidata + chinese-poetry",
  }
}

/* ───────────────────────── 抽取与打分 ───────────────────────── */

/**
 * 按信号给每条名句打分。纯规则、无模型、零延迟。
 * signals: { frustrated, completed, lateNight, taskType, keywords }
 */
export function scoreQuotes(signals = {}, candidates = listQuotes()) {
  const weights = new Map()
  const bump = (topic, weight) => weights.set(topic, (weights.get(topic) ?? 0) + weight)

  if (signals.frustrated) {
    bump("坚持", 3); bump("转机", 3); bump("韧性", 2); bump("不屈", 2); bump("豁达", 1)
  }
  if (signals.completed) {
    bump("豁达", 2); bump("担当", 2); bump("坚持", 1); bump("收获", 1)
  }
  if (signals.lateNight) {
    bump("生命", 2); bump("接受", 2); bump("豁达", 1); bump("风景", 1)
  }
  switch (signals.taskType) {
    case "debug":
      bump("专注", 3); bump("行动", 2); bump("准备", 2); bump("实践", 1); break
    case "write":
      bump("学习", 2); bump("积累", 2); bump("实践", 2); bump("气质", 1); break
    case "plan":
      bump("视野", 3); bump("格局", 2); bump("行动", 1); break
    case "review":
      bump("自省", 2); bump("积累", 1); break
    default:
      break
  }
  for (const keyword of signals.keywords ?? []) {
    for (const topic of candidates.flatMap((q) => q.topics)) {
      if (topic.includes(keyword) || keyword.includes(topic)) bump(topic, 1)
    }
  }

  const moodBias = signals.preferMood ? signals.preferMood : null
  const scored = candidates.map((quote) => {
    let score = 0
    const matched = []
    for (const [topic, weight] of weights) {
      if (quote.topics.includes(topic)) {
        score += weight
        matched.push(topic)
      }
    }
    if (moodBias && quote.mood === moodBias) score += 1
    return { quote, score, matched }
  })
  return { weights, scored }
}

/**
 * 依据信号挑一条名句。
 * excludeIds 用于避免重复；seed 保证同一天同一信号得到同一条。
 */
export function recommend(options = {}) {
  const {
    signals = {},
    excludeIds = [],
    seed = "",
    preferMood = null,
    candidates = listQuotes(),
  } = options
  const pool = candidates.filter((q) => !excludeIds.includes(q.id))
  const usable = pool.length > 0 ? pool : candidates
  const { weights, scored } = scoreQuotes({ ...signals, preferMood }, usable)
  if (scored.length === 0) return null

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
  const topScore = best.score
  // 同分时用可重放的伪随机打破平局，保证"每日一条"稳定又不单调
  const tied = scored.filter((s) => s.score === topScore)
  const rng = makeRng(hashSeed(seed + "|" + best.quote.id + "|" + topScore))
  const chosen = tied.length > 1 ? tied[Math.floor(rng() * tied.length) % tied.length] : best

  return {
    quote: chosen.quote,
    score: chosen.score,
    matched: chosen.matched,
    weights: Object.fromEntries(weights),
    reason: describeReason(chosen.matched, signals),
  }
}

/** 把匹配到的标签翻译成人话，让 UI 能解释"为什么是这句"。 */
function describeReason(matched, signals) {
  const parts = []
  if (signals.frustrated) parts.push("检测到受挫信号")
  if (signals.completed) parts.push("任务刚刚完成")
  if (signals.lateNight) parts.push("深夜时段")
  if (signals.taskType) {
    const label = { debug: "调试", write: "写作", plan: "规划", review: "复盘", chat: "闲聊" }
    parts.push(`任务类型：${label[signals.taskType] ?? signals.taskType}`)
  }
  if (matched.length > 0) parts.push(`匹配主题：${matched.join("、")}`)
  return parts.length > 0 ? parts.join(" · ") : "每日一条"
}

/** 每日一条：同一天同一 seed 永远得到同一条。 */
export function quoteOfTheDay(dateKey, options = {}) {
  return recommend({ ...options, seed: `daily:${dateKey}`, signals: options.signals ?? {} })
}

/* ───────────────────────── 归属校验 ───────────────────────── */

/** 字符 bigram 的 Dice 系数，作为"是不是同一句话"的近似。 */
function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (s) => {
    const map = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      map.set(g, (map.get(g) ?? 0) + 1)
    }
    return map
  }
  const ga = grams(a)
  const gb = grams(b)
  let overlap = 0
  for (const [g, count] of ga) overlap += Math.min(count, gb.get(g) ?? 0)
  const total = a.length - 1 + (b.length - 1)
  return (2 * overlap) / total
}

/**
 * 判定一句话的归属。
 * verdict: verified | misattributed | paraphrase_of_verified | no_match
 */
export function checkAttribution(text, claimedAuthor) {
  const key = normalizeText(text)
  if (key === "") {
    return { verdict: "no_match", reason: "空文本", citation: null }
  }

  const disputed = quotes.find((q) => q.kind === "disputed" && similarity(q.search_key, key) >= 0.6)
  if (disputed) {
    return {
      verdict: "misattributed",
      reason: disputed.reason,
      citation: {
        id: disputed.id,
        text: disputed.text,
        author: disputed.author,
        claimed_author: disputed.claimed_author,
        work: disputed.work ?? null,
        era: disputed.era ?? null,
        verification: disputed.verification,
        source: disputed.source,
      },
    }
  }

  const exact = quotes.find((q) => q.kind === "quote" && q.search_key === key)
  if (exact) {
    return {
      verdict: "verified",
      reason: "与语料库中的收录文本完全一致。",
      citation: citationOf(exact),
      author_matches: claimedAuthor ? sameAuthor(exact, claimedAuthor) : null,
    }
  }

  const near = quotes
    .filter((q) => q.kind === "quote")
    .map((q) => ({ q, score: similarity(q.search_key, key) }))
    .sort((a, b) => b.score - a.score)[0]

  if (near && near.score >= 0.75) {
    return {
      verdict: "paraphrase_of_verified",
      reason: "与语料库中的一条名句高度相似，疑似同一句的改写或讹传。",
      citation: citationOf(near.q),
      similarity: Number(near.score.toFixed(3)),
      author_matches: claimedAuthor ? sameAuthor(near.q, claimedAuthor) : null,
    }
  }

  if (claimedAuthor) {
    const person = findPerson(claimedAuthor)
    if (person) {
      const theirs = quotesByPerson(person.qid)
      if (theirs.length > 0) {
        return {
          verdict: "no_match",
          reason: "语料库中没有这句话，无法归到该作者名下。",
          citation: null,
          author_quotes: theirs.length,
        }
      }
    }
  }

  return { verdict: "no_match", reason: "语料库中没有这句话。", citation: null }
}

function citationOf(quote) {
  return {
    id: quote.id,
    text: quote.text,
    author: quote.author,
    author_qid: quote.author_qid ?? null,
    work: quote.work,
    era: quote.era ?? null,
    verification: quote.verification,
    source: quote.source,
  }
}

function sameAuthor(quote, claimedAuthor) {
  const person = findPerson(claimedAuthor)
  if (person) {
    if (quote.author_qid && quote.author_qid === person.qid) return true
    const names = new Set(
      [person.name_zh, person.name_full, ...(person.aliases ?? [])].filter(Boolean),
    )
    return names.has(quote.author)
  }
  // 声称的作者不在语料库里：依然可以和这句名句的真实作者做字面比对，
  // 否则「这句是李白的，但有人说是杜甫」会被漏判成"未知"。
  const claimed = String(claimedAuthor).trim()
  if (claimed === "") return null
  return claimed === quote.author
}

export { stats }
