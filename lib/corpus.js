// 语料加载与索引。纯 Node、零依赖，只读 data/*.jsonl。
// 这是整条链路的唯一事实源：DSH 插件、MCP server、未来任何脚本都从这里读。
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, "..", "data")

function readJsonl(name) {
  const raw = readFileSync(join(DATA_DIR, name), "utf8")
  const rows = []
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) return
    try {
      rows.push(JSON.parse(trimmed))
    } catch (err) {
      throw new Error(`${name}:${index + 1} JSON 解析失败：${err.message}`)
    }
  })
  return rows
}

export const people = readJsonl("people.jsonl")
export const quotes = readJsonl("quotes.jsonl")

export const peopleByQid = new Map(people.map((p) => [p.qid, p]))

/**
 * 作品名的「主名」：把「定风波·莫听穿林打叶声」压成「定风波」。
 * 语料里的名句用的是全名，人物代表作清单用的是简称，两边靠这个函数对齐。
 */
export function normalizeWork(work) {
  const text = String(work ?? "").trim()
  if (text === "") return ""
  const index = text.search(/[·・:：]/)
  return index > 0 ? text.slice(0, index).trim() : text
}

// 身份列表：seed 指定的身份排第一，其余去重后限量。
// Wikidata 的 occupation 常常有十几个（泰戈尔有 20 个），全展示没有信息量。
for (const person of people) {
  const all = (person.roles ?? []).filter(Boolean)
  person.roles_all = all
  const ordered = []
  const seen = new Set()
  if (person.seed_role) {
    ordered.push(person.seed_role)
    seen.add(person.seed_role)
  }
  for (const role of all) {
    if (seen.has(role)) continue
    seen.add(role)
    ordered.push(role)
  }
  person.roles = ordered.slice(0, 6)
}

/** 名字 → person。中文名、别名、全名、英文名都算命中。 */
export const peopleByName = new Map()
for (const person of people) {
  const keys = [person.name_zh, person.name_full, ...(person.aliases ?? [])].filter(Boolean)
  for (const key of keys) {
    if (!peopleByName.has(key)) peopleByName.set(key, person)
  }
  if (person.name_en && !peopleByName.has(person.name_en)) peopleByName.set(person.name_en, person)
}

/** 把 quote 的作者名对到 person 记录，补齐 qid / 生卒 / 标签。 */
for (const quote of quotes) {
  const person = peopleByName.get(quote.author)
  if (person) {
    quote.author_qid = person.qid
    quote.author_name_en = person.name_en
    quote.author_years =
      person.birth_year != null && person.death_year != null
        ? `${person.birth_year}–${person.death_year}`
        : null
    quote.era = quote.era ?? person.era
  } else {
    quote.author_qid = null
    quote.author_years = null
  }
  quote.work_base = normalizeWork(quote.work)
  quote.search_key = normalizeText(quote.text)
}

/** 去掉标点与空白，只留可比较的字符。 */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase()
}

/** 语料统计，给设置页与 MCP resources 用。 */
export function stats() {
  const peopleWithQuotes = new Set(
    quotes.filter((q) => q.kind === "quote" && q.author_qid).map((q) => q.author_qid),
  )
  const topics = new Set()
  const eras = new Set()
  for (const q of quotes) {
    if (q.kind !== "quote") continue
    q.topics.forEach((t) => topics.add(t))
    if (q.era) eras.add(q.era)
  }
  return {
    people: people.length,
    peopleWithQuotes: peopleWithQuotes.size,
    quotes: quotes.filter((q) => q.kind === "quote").length,
    disputed: quotes.filter((q) => q.kind === "disputed").length,
    topics: [...topics].sort(),
    eras: [...eras],
  }
}
