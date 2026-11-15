#!/usr/bin/env node
// dsh-classic-quotes-mcp —— 独立可复用的名人名句 / 著作生平 MCP server。
//
// 为什么自己写而不引 SDK：这个 server 必须能被任何 MCP 宿主（DSH、Claude
// Desktop、Cursor……）直接拉起，零依赖意味着不需要 pnpm/npm 安装步骤，也不会
// 因为宿主解析不到依赖而启动失败。协议本身是「按行分隔的 JSON-RPC 2.0」，
// 实现成本很低，但少一个变量。
//
// 所有查询都复用 lib/queries.js —— 与浏览器半同一份实现，保证
// 「UI 里看到的名句」和「模型引用的名句」永远一致。
import { createInterface } from "node:readline"
import {
  listQuotes,
  listPeople,
  biography,
  quoteOfTheDay,
  recommend,
  checkAttribution,
  stats,
} from "../lib/queries.js"

const SERVER_INFO = { name: "dsh-classic-quotes", version: "0.1.0" }
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const DEFAULT_PROTOCOL = "2024-11-05"

/* ───────────────────────── 工具声明 ───────────────────────── */

const TOOLS = [
  {
    name: "random_quote",
    description:
      "从名人语录库中取一条名句。可按主题(主题标签)、时代(先秦/唐/宋/明/近现代)、" +
      "作者或情绪(uplifting/reflective/stoic)过滤。适合回答「给我一句励志名言」「" +
      "李白说过什么」这类问题。返回的每条都带作品名与出处可信度。",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "主题标签，如 坚持 / 豁达 / 远行 / 挫折" },
        era: { type: "string", description: "时代：先秦 / 唐 / 宋 / 明 / 近现代" },
        author: { type: "string", description: "作者名或 Q-id，如 李白 / Q7071" },
        mood: { type: "string", description: "情绪：uplifting / reflective / stoic" },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "要避开的语料 id 列表，避免重复",
        },
      },
    },
  },
  {
    name: "quote_of_the_day",
    description:
      "返回「每日一条」：同一天、同一参数永远得到同一条名句。适合做每日语录卡片或" +
      "确定性引用，避免每次回答都换一句。",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "日期键 YYYY-MM-DD，默认今天" },
        topic: { type: "string", description: "可选的主题过滤" },
      },
    },
  },
  {
    name: "recommend_quote",
    description:
      "按「用户此刻在做什么」推荐一条名句。纯规则打分、无模型调用、零延迟。" +
      "signals 描述用户当前状态：受挫(frustrated)、刚完成(completed)、深夜(lateNight)、" +
      "任务类型(taskType: debug/write/plan/review/chat)、关键词(keywords)。",
    inputSchema: {
      type: "object",
      properties: {
        frustrated: { type: "boolean", description: "用户正在受挫、反复失败" },
        completed: { type: "boolean", description: "用户刚刚完成一个任务" },
        lateNight: { type: "boolean", description: "深夜时段" },
        taskType: {
          type: "string",
          enum: ["debug", "write", "plan", "review", "chat"],
          description: "任务类型",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "从用户输入里抽出的关键词，用于主题匹配",
        },
      },
    },
  },
  {
    name: "quotes_by_person",
    description:
      "取某位人物的语料库名句全集。支持中文名、别名、英文名与 Wikidata Q-id。" +
      "如 李白 / 太白 / Li Bai / Q7071 都可命中。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "人物名或 Q-id" },
      },
      required: ["name"],
    },
  },
  {
    name: "biography",
    description:
      "取某位人物的结构化生平档案：生卒年、时代、身份、简介、代表作，以及该人物的" +
      "全部名句。数据来自 Wikidata，出处可回溯。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "人物名或 Q-id" },
      },
      required: ["name"],
    },
  },
  {
    name: "works_by_author",
    description: "取某位人物的代表作清单（作品名 + 该作品下的名句）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "人物名或 Q-id" },
      },
      required: ["name"],
    },
  },
  {
    name: "check_attribution",
    description:
      "核查一句话的归属。返回四种结论之一：verified（语料中确有此句，且署名正确）、" +
      "misattributed（广为流传的误传，如「Elementary, my dear Watson」）、" +
      "paraphrase_of_verified（与某条名句高度相似的改写）、no_match（语料中没有）。" +
      "用于回答「这句话真是他说的吗」。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要核查的原句" },
        author: { type: "string", description: "声称的作者" },
      },
      required: ["text"],
    },
  },
]

/* ───────────────────────── 资源声明 ───────────────────────── */

const RESOURCES = [
  {
    uri: "quote://today",
    name: "每日一条",
    description: "今天的推荐名句，含作者与出处",
    mimeType: "application/json",
  },
  {
    uri: "quote://people",
    name: "人物列表",
    description: "语料库覆盖的人物及其生平摘要、代表作、名句数量",
    mimeType: "application/json",
  },
  {
    uri: "quote://quotes",
    name: "全部名句",
    description: "语料库中所有可展示的名句",
    mimeType: "application/json",
  },
  {
    uri: "quote://stats",
    name: "语料统计",
    description: "人物数、名句数、主题标签与时代分布",
    mimeType: "application/json",
  },
]

/* ───────────────────────── 输出格式 ───────────────────────── */

function formatQuote(quote) {
  const lines = [`「${quote.text}」`, `—— ${quote.author}《${quote.work}》`]
  if (quote.author_years) lines[1] += ` · ${quote.author_years}`
  if (quote.topics?.length) lines.push(`主题：${quote.topics.join("、")}`)
  const badge =
    quote.verification === "curated"
      ? "出处已核查"
      : quote.verification === "disputed"
        ? "存在争议"
        : "出处待核"
  lines.push(`[${badge}]${quote.author_qid ? ` Wikidata: ${quote.author_qid}` : ""}`)
  return lines.join("\n")
}

function formatPersonCard(card) {
  const lines = [
    `${card.name}${card.name_en ? `（${card.name_en}）` : ""}`,
    card.birth != null ? `生卒：${card.birth}–${card.death}` : "",
    card.era ? `时代：${card.era}` : "",
    card.roles?.length ? `身份：${card.roles.join("、")}` : "",
    card.description ? `简介：${card.description}` : "",
    card.works?.length ? `代表作：${card.works.join("、")}` : "",
    card.qid ? `Wikidata：${card.qid}` : "",
  ].filter(Boolean)
  return lines.join("\n")
}

const VERDICT_LABEL = {
  verified: "已核查 —— 语料库中有此句",
  misattributed: "误传 —— 这句话并不出自所称作者",
  paraphrase_of_verified: "疑似改写 —— 与语料库中的名句高度相似",
  no_match: "未收录 —— 语料库中没有这句话",
}

/* ───────────────────────── 工具实现 ───────────────────────── */

function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function runTool(name, args = {}) {
  switch (name) {
    case "random_quote": {
      const pool = listQuotes({
        topic: args.topic,
        era: args.era,
        author: args.author,
        mood: args.mood,
      })
      if (pool.length === 0) {
        return { text: "没有符合条件的名句。请放宽 topic / era / author 过滤条件。" }
      }
      const exclude = new Set(args.exclude ?? [])
      const usable = pool.filter((q) => !exclude.has(q.id))
      const finalPool = usable.length > 0 ? usable : pool
      // 用「今天 + 过滤条件 + 候选集」做种子，同一天同一条件下结果稳定可复现。
      const result = recommend({
        candidates: finalPool,
        seed: `mcp:${todayKey()}:${name}:${args.topic ?? ""}:${args.era ?? ""}:${args.author ?? ""}`,
      })
      return { text: formatQuote(result.quote) }
    }

    case "quote_of_the_day": {
      const date = args.date ?? todayKey()
      const result = quoteOfTheDay(date, {
        candidates: args.topic ? listQuotes({ topic: args.topic }) : undefined,
      })
      if (!result) return { text: "没有可用名句。" }
      return { text: `${date}\n${formatQuote(result.quote)}` }
    }

    case "recommend_quote": {
      const result = recommend({
        signals: {
          frustrated: args.frustrated,
          completed: args.completed,
          lateNight: args.lateNight,
          taskType: args.taskType,
          keywords: args.keywords,
        },
        seed: `mcp:${todayKey()}:${JSON.stringify(args)}`,
      })
      if (!result) return { text: "没有可用名句。" }
      return {
        text: `${formatQuote(result.quote)}\n推荐理由：${result.reason}`,
      }
    }

    case "quotes_by_person": {
      const card = biography(args.name)
      if (!card) return { text: `语料库中没有找到「${args.name}」。`, isError: true }
      if (card.quotes.length === 0) {
        return { text: `${card.name} 暂无收录名句。\n${formatPersonCard(card)}` }
      }
      return {
        text: [
          formatPersonCard(card),
          "",
          "名句：",
          ...card.quotes.map((q) => "· " + formatQuote(q)),
        ].join("\n"),
      }
    }

    case "biography": {
      const card = biography(args.name)
      if (!card) return { text: `语料库中没有找到「${args.name}」。`, isError: true }
      return {
        text: [
          formatPersonCard(card),
          "",
          "名句：",
          ...(card.quotes.length > 0
            ? card.quotes.map((q) => "· " + formatQuote(q))
            : ["（暂无收录名句）"]),
          "",
          `数据来源：${card.source}`,
        ].join("\n"),
      }
    }

    case "works_by_author": {
      const card = biography(args.name)
      if (!card) return { text: `语料库中没有找到「${args.name}」。`, isError: true }
      const lines = [`${card.name} 的代表作与收录名句：`, ""]
      for (const work of card.works_detail ?? []) {
        lines.push(`《${work.name}》`)
        if (work.quotes.length === 0) {
          lines.push("（暂无收录名句）")
        } else {
          lines.push(...work.quotes.map((q) => `· 「${q.text}」`))
        }
        lines.push("")
      }
      return { text: lines.join("\n").trim() }
    }

    case "check_attribution": {
      const result = checkAttribution(args.text ?? "", args.author ?? "")
      const lines = [`结论：${VERDICT_LABEL[result.verdict] ?? result.verdict}`, result.reason]
      if (result.author_matches === false && result.citation) {
        lines.push(
          `注意：原句确为 ${result.citation.author} 所作，但声称的作者是 ${args.author}。`,
        )
      }
      if (result.citation) {
        lines.push("")
        const work = result.citation.work && result.citation.work !== "—" ? `《${result.citation.work}》` : ""
        lines.push(
          `出处：${work}${result.citation.author}` +
            (result.citation.author_qid ? ` · Wikidata ${result.citation.author_qid}` : ""),
        )
      }
      if (result.author_quotes) {
        lines.push(`（${args.author} 在语料库中另有 ${result.author_quotes} 条名句）`)
      }
      return { text: lines.join("\n") }
    }

    default:
      return { text: `未知工具：${name}`, isError: true }
  }
}

function readResource(uri) {
  switch (uri) {
    case "quote://today": {
      const result = quoteOfTheDay(todayKey())
      return JSON.stringify(
        { date: todayKey(), quote: result?.quote ?? null, reason: result?.reason ?? null },
        null,
        2,
      )
    }
    case "quote://people":
      return JSON.stringify(listPeople(), null, 2)
    case "quote://quotes":
      return JSON.stringify(listQuotes(), null, 2)
    case "quote://stats":
      return JSON.stringify(stats(), null, 2)
    default:
      return null
  }
}

/* ───────────────────────── JSON-RPC 循环 ───────────────────────── */

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } })
}

function handle(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "提供名人的名句、著作与生平档案。每条名句都带出处与核查状态。" +
          "引用前建议先用 check_attribution 确认归属。",
      })
      return
    }

    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return

    case "ping":
      if (!isNotification) reply(id, {})
      return

    case "tools/list":
      reply(id, { tools: TOOLS })
      return

    case "tools/call": {
      const toolName = params?.name
      try {
        const result = runTool(toolName, params?.arguments ?? {})
        reply(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        })
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: `工具执行失败：${err?.message ?? err}` }],
          isError: true,
        })
      }
      return
    }

    case "resources/list":
      reply(id, { resources: RESOURCES })
      return

    case "resources/templates/list":
      reply(id, { resourceTemplates: [] })
      return

    case "resources/read": {
      const uri = params?.uri
      const body = readResource(uri)
      if (body === null) {
        replyError(id, -32602, `未知资源：${uri}`)
        return
      }
      reply(id, {
        contents: [{ uri, mimeType: "application/json", text: body }],
      })
      return
    }

    case "prompts/list":
      reply(id, { prompts: [] })
      return

    default:
      if (!isNotification) replyError(id, -32601, `未实现的方法：${method}`)
  }
}

function main() {
  // stdout 只能有 JSON-RPC 消息，所有日志走 stderr。
  process.stderr.write(`[dsh-classic-quotes] MCP server 已启动（${SERVER_INFO.name} ${SERVER_INFO.version}）\n`)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on("line", (line) => {
    const trimmed = line.trim()
    if (trimmed === "") return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch (err) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    try {
      handle(message)
    } catch (err) {
      process.stderr.write(`[dsh-classic-quotes] 处理失败：${err?.stack ?? err}\n`)
      if (message?.id !== undefined && message?.id !== null) {
        replyError(message.id, -32603, String(err?.message ?? err))
      }
    }
  })
  rl.on("close", () => process.exit(0))
}

main()
