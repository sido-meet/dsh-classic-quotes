"""dsh-classic-quotes 浏览器端回归测试。

需要一个已经跑起来的 DSH WebUI：

    dsh --profile quote-test --port 8791
    python scripts/browser-smoke.py http://127.0.0.1:8791 <token> [截图目录]

它验证的是「client 半真的在浏览器里跑起来了」——这类问题（非法 selector、
浮层定位算错、React 引用未定义变量）静态检查抓不到，只有真跑一遍浏览器才暴露。
"""
import sys
import os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8791"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
OUT = sys.argv[3] if len(sys.argv) > 3 else ""

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print("  ok   " + name)
    else:
        failed += 1
        print("  FAIL " + name + (("  -> " + str(detail)[:300]) if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "console",
            lambda m: errors.append(m.text) if m.type == "error" and "dsh-classic-quotes" in m.text else None,
        )
        page.goto(f"{BASE}/?token={TOKEN}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)

        print("\n侧栏每日一条")
        check("侧栏渲染出语录", page.locator(".dq-text").count() >= 1)
        check("侧栏有设置按钮", page.locator(".dq-gear").count() >= 1)
        check("侧栏有作者署名", "——" in page.inner_text(".dq-meta"))

        print("\n生平浮层")
        page.evaluate("document.querySelector('.dq-text').click()")
        page.wait_for_timeout(1200)
        check("生平浮层打开", page.locator(".dq-pop").count() >= 1)
        if page.locator(".dq-pop").count():
            box = page.locator(".dq-pop").last.bounding_box()
            check("浮层完整落在视口内", box is not None and box["y"] >= 0 and box["y"] + box["height"] <= 901,
                  box)
            check("浮层里有生平与代表作", "生平" in page.locator(".dq-pop").last.inner_text())

        print("\n设置浮层与语录墙")
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        page.evaluate("document.querySelector('.dq-gear').click()")
        page.wait_for_timeout(800)
        check("设置浮层打开", page.locator(".dq-pop").count() >= 1)
        check("设置项齐全",
              all(t in page.inner_text(".dq-pop") for t in ["刷新频率", "按聊天情况推荐", "回合鼓励卡", "浏览全部名句"]))
        page.evaluate("[...document.querySelectorAll('.dq-btn')].find(b => b.textContent === '浏览全部名句').click()")
        page.wait_for_timeout(1800)
        check("语录墙渲染", page.locator(".dq-wall").count() >= 1)
        if page.locator(".dq-wall").count():
            check("语录墙有卡片", page.locator(".dq-card").count() >= 10,
                  page.locator(".dq-card").count())
            check("语录墙有时代筛选", page.locator(".dq-wall-filters .dq-mini").count() >= 5)

        print("\n运行期错误")
        plugin_errors = [e for e in errors if "dsh-classic-quotes" in e or "slot entry crashed" in e]
        check("插件没有运行期错误", len(plugin_errors) == 0, " | ".join(plugin_errors[:3]))

        if OUT:
            os.makedirs(OUT, exist_ok=True)
            page.screenshot(path=f"{OUT}/webui.png")
            print(f"\n截图：{OUT}/webui.png")

        browser.close()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
