// Node half of dsh-classic-quotes.
//
// 只做一件事：把语料库以只读 JSON API 的形式暴露给浏览器半。
// 所有查询逻辑都在 lib/queries.js（纯函数），这里只负责 HTTP 边界。
// 路由前缀固定为 /plugins/dsh-classic-quotes，不监听任何其他路径，也不做任何写操作。
import {
  listQuotes,
  listPeople,
  biography,
  quoteOfTheDay,
  recommend,
  checkAttribution,
  stats,
} from "./queries.js"

const PREFIX = "/plugins/dsh-classic-quotes"

function send(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  res.end(JSON.stringify(payload))
}

/** 只接受回环来源。这是只读接口，没有副作用，但仍然拒绝外部页面读取。 */
function isTrustedHost(host) {
  if (!host) return true
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
}

function parseSignals(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function apply(ctx) {
  // 软依赖：非 web profile 没有 webServer 服务，回调不会触发，本插件保持安全空操作。
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register(
          {
            kind: "prefix",
            path: PREFIX,
            handler: async (req, res) => {
              if (req.method !== "GET" && req.method !== "HEAD") {
                res.writeHead(405, { allow: "GET, HEAD" })
                res.end()
                return
              }
              if (!isTrustedHost(req.headers.host)) {
                res.writeHead(403)
                res.end()
                return
              }

              const url = new URL(req.url, "http://127.0.0.1")
              const route = url.pathname.slice(PREFIX.length).replace(/^\/+/, "") || "today"
              const params = url.searchParams

              try {
                switch (route) {
                  case "today": {
                    const date = params.get("date") ?? todayKey()
                    const exclude = (params.get("exclude") ?? "").split(",").filter(Boolean)
                    const signals = parseSignals(params.get("signals"))
                    const mode = params.get("mode") ?? "daily"
                    const result =
                      mode === "open"
                        ? recommend({
                            signals,
                            excludeIds: exclude,
                            seed: `open:${date}:${exclude.length}:${signals.taskType ?? ""}`,
                          })
                        : quoteOfTheDay(date, { signals, excludeIds: exclude })
                    if (!result) {
                      send(res, 404, { error: "no quote available" })
                      return
                    }
                    send(res, 200, {
                      ...result,
                      author: personCard(result.quote),
                      date,
                      mode,
                    })
                    return
                  }
                  case "quotes": {
                    send(res, 200, {
                      quotes: listQuotes({
                        author: params.get("author") ?? undefined,
                        topic: params.get("topic") ?? undefined,
                        era: params.get("era") ?? undefined,
                        mood: params.get("mood") ?? undefined,
                        domain: params.get("domain") ?? undefined,
                      }),
                    })
                    return
                  }
                  case "people": {
                    send(res, 200, { people: listPeople({ era: params.get("era") ?? undefined }) })
                    return
                  }
                  case "biography": {
                    const card = biography(params.get("name") ?? "")
                    if (!card) {
                      send(res, 404, { error: "person not found" })
                      return
                    }
                    send(res, 200, card)
                    return
                  }
                  case "check": {
                    send(res, 200, checkAttribution(params.get("text") ?? "", params.get("author") ?? ""))
                    return
                  }
                  case "stats": {
                    send(res, 200, stats())
                    return
                  }
                  default:
                    send(res, 404, { error: "unknown route", route })
                    return
                }
              } catch (err) {
                send(res, 500, { error: String(err?.message ?? err) })
                return
              }
            },
          },
          "dsh-classic-quotes: api",
        ),
      "dsh-classic-quotes: api route",
    )
  })
}

function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 把一条名句补上作者卡片信息。 */
function personCard(quote) {
  if (!quote.author_qid) {
    return { name: quote.author, years: quote.author_years ?? null, qid: null }
  }
  const card = biography(quote.author_qid)
  if (!card) return { name: quote.author, years: quote.author_years ?? null, qid: quote.author_qid }
  return {
    name: card.name,
    name_en: card.name_en,
    qid: card.qid,
    years: card.birth != null && card.death != null ? `${card.birth}–${card.death}` : null,
    era: card.era,
    roles: card.roles,
    description: card.description,
    works: card.works,
    wikipedia_zh: card.wikipedia_zh,
  }
}
