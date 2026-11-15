"""重新生成 desktop 版截图（6 张），供 README / 发布页使用。

    python scripts/desktop-shots.py http://127.0.0.1:8793 <token> <输出目录>
"""
import sys
import os
sys.stdout.reconfigure(encoding="utf-8")
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
TOKEN = sys.argv[2]
OUT = sys.argv[3]
os.makedirs(OUT, exist_ok=True)

FRUSTRATED = "这个 bug 我改了三个小时还是修不好，试了各种方法都不行，真的很沮丧"


def open_settings(page):
    """确保设置浮层是打开的。点齿轮是幂等的，但浮层可能叠着生平浮层。"""
    for _ in range(4):
        if page.locator(".dq-pop .dq-btn").count():
            return True
        page.evaluate("document.querySelector('.dq-gear').click()")
        page.wait_for_timeout(900)
    return page.locator(".dq-pop .dq-btn").count() > 0


def close_pops(page):
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    # 有些浮层靠点击遮罩关闭，补一刀：点空白。
    page.mouse.click(1380, 40)
    page.wait_for_timeout(400)


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(f"{BASE}/?token={TOKEN}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(9000)

    # 1 侧栏 + 生平浮层
    page.locator(".dq-text").first.scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    page.locator(".dq-text").first.click()
    page.wait_for_timeout(1400)
    pop = page.locator(".dq-pop").last
    assert pop.count(), "生平浮层没打开"
    assert "生平" in pop.inner_text(), "浮层里没有生平"
    box = pop.bounding_box()
    assert box and box["y"] >= 0 and box["y"] + box["height"] <= 901, f"浮层出屏: {box}"
    page.screenshot(path=f"{OUT}/desktop-02-biography.png")
    print("desktop-02-biography.png", box)
    close_pops(page)

    # 2 设置浮层
    assert open_settings(page), "设置浮层没打开"
    page.screenshot(path=f"{OUT}/desktop-01-settings.png")
    print("desktop-01-settings.png")
    close_pops(page)

    # 3 语录墙
    assert open_settings(page), "设置浮层没打开"
    page.get_by_role("button", name="浏览全部名句").first.click()
    page.wait_for_timeout(2000)
    assert page.locator(".dq-card").count() >= 10, "语录墙卡片不足"
    page.screenshot(path=f"{OUT}/desktop-03-wall.png")
    print("desktop-03-wall.png", page.locator(".dq-card").count())
    close_pops(page)

    # 4 侧栏常驻
    page.screenshot(path=f"{OUT}/desktop-01-sidebar.png")
    print("desktop-01-sidebar.png")

    # 5 回合鼓励卡
    editor = page.locator('div[contenteditable="true"]').last
    editor.click()
    page.wait_for_timeout(300)
    editor.fill(FRUSTRATED)
    page.wait_for_timeout(500)
    editor.press("Enter")
    page.wait_for_selector(".dq-turn", timeout=180000)
    page.wait_for_timeout(2500)
    page.locator(".dq-turn").last.scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}/desktop-04-turntail.png")
    print("desktop-04-turntail.png")

    # 6 会话内语录墙 tab
    tab = page.get_by_text("语录墙", exact=True).first
    if tab.count():
        tab.click()
        page.wait_for_timeout(1800)
        page.screenshot(path=f"{OUT}/desktop-05-walltab.png")
        print("desktop-05-walltab.png")

    browser.close()
print("done")
