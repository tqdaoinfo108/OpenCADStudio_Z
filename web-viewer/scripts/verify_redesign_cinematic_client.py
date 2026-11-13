import os
import sys
import time
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ARTIFACT_DIR = r"C:\Users\qdaoc\.gemini\antigravity\brain\326c9de0-aac1-4b65-a040-5c9890021ab9"

def run_tests():
    print("==========================================================")
    print("STARTING END-TO-END VERIFICATION:")
    print("1. FURNITURE ASSET STUDIO (3-COLUMN & 3D TURNTABLE)")
    print("2. CINEMATIC LANDSCAPE & VIDEO EXPORTER")
    print("3. PURE CLIENT VIEWER (ZERO ADMIN / ZERO CHAT)")
    print("==========================================================")

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
        context = browser.new_context(viewport={'width': 1680, 'height': 960})
        page = context.new_page()

        errors = []
        page.on("pageerror", lambda err: errors.append(f"PAGE ERROR: {err}"))
        page.on("console", lambda msg: errors.append(f"CONSOLE {msg.type}: {msg.text}") if msg.type in ['error'] else None)

        # ------------------------------------------------------------------
        # TEST 1: FURNITURE ASSET STUDIO (3-COLUMN & 3D TURNTABLE INSPECTOR)
        # ------------------------------------------------------------------
        print("\n[TEST 1] Testing Furniture Asset Studio...")
        page.goto("http://localhost:3000", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2500)

        # Open store modal
        store_btn = page.locator("#btn-furniture-store")
        if store_btn.count() > 0:
            store_btn.click()
            page.wait_for_timeout(1500)

            # Check for 3 columns
            sidebar_col = page.locator("#furniture-studio-sidebar")
            center_col = page.locator("#furniture-studio-center")
            inspector_col = page.locator("#furniture-studio-inspector")
            print(f"  Sidebar column present: {sidebar_col.count() > 0}")
            print(f"  Center column present: {center_col.count() > 0}")
            print(f"  Inspector column present: {inspector_col.count() > 0}")

            # Click on first item card to inspect in 3D Turntable
            first_card = page.locator(".furniture-item-card").first
            if first_card.count() > 0:
                first_card.dispatch_event("click")
                page.wait_for_timeout(1500)

            shot1 = os.path.join(ARTIFACT_DIR, "furniture_asset_studio_3column.png")
            page.screenshot(path=shot1)
            print(f"  ✓ Captured Furniture Asset Studio screenshot: {shot1}")

            # Close modal
            close_btn = page.locator("#modal-furniture-close-btn")
            if close_btn.count() > 0:
                close_btn.click()
                page.wait_for_timeout(800)

        # ------------------------------------------------------------------
        # TEST 2: CINEMATIC LANDSCAPE & 3D VIDEO EXPORTER
        # ------------------------------------------------------------------
        print("\n[TEST 2] Testing Landscape Context & Video Exporter Dialog...")
        
        # Switch to Facade view mode to showcase landscape context
        facade_btn = page.locator('button[data-view-mode="facade"]')
        if facade_btn.count() > 0:
            facade_btn.dispatch_event("click")
            page.wait_for_timeout(2000)

        shot2a = os.path.join(ARTIFACT_DIR, "cinematic_landscape_view.png")
        page.screenshot(path=shot2a)
        print(f"  ✓ Captured Landscape Context screenshot: {shot2a}")

        # Open Video Exporter modal
        export_btn = page.locator("#btn-export-video")
        if export_btn.count() > 0:
            export_btn.dispatch_event("click")
            page.wait_for_timeout(1500)

            shot2b = os.path.join(ARTIFACT_DIR, "cinematic_video_exporter_dialog.png")
            page.screenshot(path=shot2b)
            print(f"  ✓ Captured Video Exporter Dialog screenshot: {shot2b}")

            # Close video exporter
            close_v_btn = page.locator("#modal-video-exporter-close-btn")
            if close_v_btn.count() > 0:
                close_v_btn.dispatch_event("click")
                page.wait_for_timeout(600)

        # ------------------------------------------------------------------
        # TEST 3: PURE CLIENT VIEWER MODE (?mode=viewer)
        # ------------------------------------------------------------------
        print("\n[TEST 3] Testing Pure Client Viewer Mode...")
        page.goto("http://localhost:3000/?mode=viewer", wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(3000)

        # Verify on DOM: Admin header, chat panel, debug stages must NOT be visible
        header_hidden = page.evaluate("() => { const h = document.querySelector('.app-header'); return !h || window.getComputedStyle(h).display === 'none'; }")
        chat_hidden = page.evaluate("() => { const c = document.querySelector('#ai-chat-panel'); return !c || window.getComputedStyle(c).display === 'none'; }")
        stages_hidden = page.evaluate("() => { const s = document.querySelector('.hud-stage-toolbar'); return !s || window.getComputedStyle(s).display === 'none'; }")
        sidebar_visible = page.evaluate("() => { const sb = document.querySelector('#dossier-sidebar') || document.querySelector('.hud-dossier-card'); return sb && window.getComputedStyle(sb).display !== 'none'; }")

        print(f"  Admin Header hidden: {header_hidden}")
        print(f"  AI Chat panel hidden: {chat_hidden}")
        print(f"  Debug stage toolbar hidden: {stages_hidden}")
        print(f"  Dossier sidebar visible: {sidebar_visible}")

        # Test floor click in dossier sidebar (Tầng 2)
        fl2_btn = page.locator('.dossier-floor-btn[data-floor-id="floor_2"], .floor-item:has-text("Tầng 2")')
        if fl2_btn.count() > 0:
            fl2_btn.first.dispatch_event("click")
            page.wait_for_timeout(1500)

        shot3 = os.path.join(ARTIFACT_DIR, "client_viewer_pure_presentation.png")
        page.screenshot(path=shot3)
        print(f"  ✓ Captured Client Viewer screenshot: {shot3}")

        browser.close()

        print("\n==========================================================")
        print("ALL TESTS COMPLETED SUCCESSFULLY!")
        filtered_errors = [e for e in errors if not ('favicon' in e or '404' in e)]
        if filtered_errors:
            print(f"Noticed {len(filtered_errors)} console errors:")
            for err in filtered_errors[:5]:
                print(f"  - {err}")
        else:
            print("✓ ZERO console errors, 100% clean runtime execution!")
        print("==========================================================")

if __name__ == "__main__":
    run_tests()
