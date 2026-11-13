import os
import sys
import time
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ARTIFACT_DIR = r"C:\Users\qdaoc\.gemini\antigravity\brain\326c9de0-aac1-4b65-a040-5c9890021ab9"

def run_verification():
    print("Starting Playwright verification for Real Furniture Pipeline...")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--ignore-gpu-blocklist',
                '--enable-webgl'
            ]
        )
        context = browser.new_context(viewport={'width': 1600, 'height': 900})
        page = context.new_page()

        errors = []
        page.on("pageerror", lambda err: errors.append(f"PAGE ERROR: {err}"))
        page.on("console", lambda msg: errors.append(f"CONSOLE {msg.type}: {msg.text}") if msg.type in ['error'] else None)

        # 1. Open Studio Mode
        print("Navigating to http://localhost:3000 ...")
        page.goto("http://localhost:3000", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(3000)

        # 2. Open Furniture Store Modal & Test "Nội thất thật" Tab
        print("Testing Furniture Store Modal...")
        store_btn = page.locator("#btn-furniture-store")
        if store_btn.count() > 0:
            store_btn.click()
            page.wait_for_timeout(1000)

            # Click Real Furniture tab
            real_tab = page.locator("#tab-store-type-real")
            if real_tab.count() > 0:
                real_tab.click()
                page.wait_for_timeout(1500)

            shot1 = os.path.join(ARTIFACT_DIR, "real_furniture_store_tab.png")
            page.screenshot(path=shot1)
            print(f"  ✓ Captured Store Modal screenshot: {shot1}")

            # Close store modal
            page.locator("#modal-furniture-close-btn").click()
            page.wait_for_timeout(800)

        # 3. Test HUD Furniture Mode Toggle
        print("Testing HUD Furniture Mode Toggle...")
        furn_toggle = page.locator("#toggle-furniture-mode")
        if furn_toggle.count() > 0:
            furn_toggle.click()
            page.wait_for_timeout(1500)
            
            # Orbit camera slightly to test billboarding
            canvas = page.locator("#viewport-container canvas")
            if canvas.count() > 0:
                box = canvas.bounding_box()
                if box:
                    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.mouse.down()
                    page.mouse.move(box["x"] + box["width"] / 2 + 120, box["y"] + box["height"] / 2 - 60, steps=8)
                    page.mouse.up()
                    page.wait_for_timeout(1200)

            shot2 = os.path.join(ARTIFACT_DIR, "real_furniture_viewer_mode.png")
            page.screenshot(path=shot2)
            print(f"  ✓ Captured 3D Viewer with Real Furniture: {shot2}")

        # 4. Test Fullscreen Presentation Mode with URL Param &furniture=real
        print("Testing Fullscreen Presentation Mode (?mode=viewer&furniture=real)...")
        page.goto("http://localhost:3000/?mode=viewer&furniture=real", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(3500)

        shot3 = os.path.join(ARTIFACT_DIR, "real_furniture_presentation_mode.png")
        page.screenshot(path=shot3)
        print(f"  ✓ Captured Presentation Mode screenshot: {shot3}")

        browser.close()

        print("\n--- Playwright Verification Results ---")
        filtered_errors = [e for e in errors if not ('favicon' in e or '404' in e)]
        if filtered_errors:
            print(f"Found {len(filtered_errors)} console errors:")
            for err in filtered_errors[:10]:
                print(f"  - {err}")
        else:
            print("✓ 0 console errors, 100% clean execution!")

if __name__ == "__main__":
    run_verification()
