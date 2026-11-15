"""dsh-classic-quotes 回合鼓励卡回归测试。

需要已经跑起来的 DSH WebUI：

    python scripts/turn-smoke.py http://127.0.0.1:8793 <token> [截图目录]

它验证两件静态检查抓不到的事：
1. user-text 旁听没有触发 UserTextTransformError（返回 null 而不是 undefined 就会炸）；
2. 回合鼓励卡真的按聊天内容变了推荐，并给出可读的理由。
"""
import sys
import os
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8791"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else ""
OUT = sys.argv[3] if len(sys.argv) > 3 else ""

FRUSTRATED = "这个 bug 我改了三个小时还是修不好，试了各种方法都不行，真的很沮丧"

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
    global passed, failed
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto(f"{BASE}/?token={TOKEN}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(9000)

        print("\n旁听用户输入")
        editor = page.locator('div[contenteditable="true"]').last
        editor.click()
        page.wait_for_timeout(300)
        editor.fill(FRUSTRATED)
        page.wait_for_timeout(600)
        check("输入框收到文字", FRUSTRATED[:8] in editor.inner_text())

        print("\n发送并等待回合鼓励卡")
        editor.press("Enter")
        page.wait_for_selector(".dq-turn", timeout=180000)
        page.wait_for_timeout(2500)
        check("回合鼓励卡出现", page.locator(".dq-turn").count() >= 1)

        if page.locator(".dq-turn").count():
            text = page.locator(".dq-turn").last.inner_text()
            check("鼓励卡有正文", len(text.strip()) > 6, text)
            check("鼓励卡有署名", "——" in text, text)
            if page.locator(".dq-turn-why").count():
                why = page.locator(".dq-turn-why").last.inner_text()
                check("给出推荐理由", len(why.strip()) > 2, why)
                check("理由含匹配主题", "匹配主题" in why, why)
            else:
                check("给出推荐理由", False, "没有 .dq-turn-why")
            # 受挫信号出现在卡头（payload.reason），不在 why chips 里。
            check("卡头识别出受挫信号", "受挫" in text, text)

        print("\n运行期错误")
        rule_errors = [e for e in errors if "user-text" in e or "UserTextTransformError" in e]
        check("user-text 规则没有报错", len(rule_errors) == 0, " | ".join(rule_errors[:3]))
        plugin_errors = [e for e in errors if "dsh-classic-quotes" in e or "slot entry crashed" in e]
        check("插件没有运行期错误", len(plugin_errors) == 0, " | ".join(plugin_errors[:3]))

        if OUT:
            os.makedirs(OUT, exist_ok=True)
            page.screenshot(path=f"{OUT}/desktop-04-turntail.png")
            print(f"\n截图：{OUT}/desktop-04-turntail.png")

        browser.close()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
