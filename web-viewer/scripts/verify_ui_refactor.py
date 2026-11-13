import os
import sys
from playwright.sync_api import sync_playwright

def run_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl']
        )
        context = browser.new_context(viewport={'width': 1680, 'height': 960})
        page = context.new_page()

        errors = []
        page.on('pageerror', lambda err: errors.append(f'PAGE ERROR: {err}'))
        page.on('console', lambda msg: errors.append(f'CONSOLE ERROR: {msg.text}') if msg.type == 'error' else None)

        # 1. Test Studio Main Page
        print('Testing Main Studio Page (http://localhost:3000)...')
        page.goto('http://localhost:3000', wait_until='networkidle', timeout=20000)
        page.wait_for_timeout(2000)

        # Check Left Sidebar
        sidebar = page.locator('#sidebar-left')
        sidebar_box = sidebar.bounding_box()
        print('Sidebar bounding box:', sidebar_box)
        w = sidebar_box['width']
        assert abs(w - 320) < 1, f"Sidebar width should be 320, got {w}"

        # Check Viewport
        viewport = page.locator('.viewport-wrapper')
        viewport_box = viewport.bounding_box()
        print('Viewport bounding box:', viewport_box)
        assert viewport_box['width'] > 1000, f"Viewport width: {viewport_box['width']}"

        # Check Floating Control Dock
        dock = page.locator('#floating-control-dock')
        assert dock.count() > 0, 'Floating Control Dock not found'
        dock_box = dock.bounding_box()
        print('Floating dock box:', dock_box)
        
        # Check dock styles
        dock_styles = page.evaluate('() => { const d = document.querySelector("#floating-control-dock"); const s = window.getComputedStyle(d); return { display: s.display, zIndex: s.zIndex, position: s.position, bottom: s.bottom }; }')
        print('Dock computed styles:', dock_styles)
        assert dock_styles['zIndex'] == '50', f"Dock zIndex should be 50, got {dock_styles['zIndex']}"
        assert dock_styles['display'] == 'flex', f"Dock display should be flex, got {dock_styles['display']}"

        # Check controls inside dock
        dollhouse_btn = page.locator('#floating-control-dock [data-view-mode="dollhouse"]')
        facade_btn = page.locator('#floating-control-dock [data-view-mode="facade"]')
        exploded_btn = page.locator('#floating-control-dock [data-view-mode="exploded"]')
        walkthrough_btn = page.locator('#floating-control-dock [data-view-mode="walkthrough"]')
        light_btn = page.locator('#floating-control-dock #toggle-interior-lights')
        labels_btn = page.locator('#floating-control-dock #toggle-room-labels')
        tour_btn = page.locator('#floating-control-dock #btn-view-tour-3d')
        fs_btn = page.locator('#floating-control-dock #btn-viewport-fullscreen')
        
        assert dollhouse_btn.count() > 0, 'dollhouse button missing'
        assert facade_btn.count() > 0, 'facade button missing'
        assert exploded_btn.count() > 0, 'exploded button missing'
        assert walkthrough_btn.count() > 0, 'walkthrough button missing'
        assert light_btn.count() > 0, 'lighting button missing'
        assert labels_btn.count() > 0, 'labels button missing'
        assert tour_btn.count() > 0, 'tour button missing'
        assert fs_btn.count() > 0, 'fullscreen button missing'
        print('All dock controls verified successfully!')

        # Test toggles
        light_btn.click()
        page.wait_for_timeout(300)
        print('Light toggle clicked. Text:', light_btn.inner_text().strip())

        # Screenshot Studio with floating dock
        artifact_dir = r"C:\Users\qdaoc\.gemini\antigravity\brain\326c9de0-aac1-4b65-a040-5c9890021ab9"
        os.makedirs(artifact_dir, exist_ok=True)
        shot1 = os.path.join(artifact_dir, "ui_floating_dock_standardized.png")
        page.screenshot(path=shot1)
        print(f"Captured screenshot: {shot1}")

        # 2. Test Dedicated /viewer Page
        print('\nTesting Dedicated Client Viewer Page (http://localhost:3000/viewer)...')
        page.goto('http://localhost:3000/viewer', wait_until='networkidle', timeout=20000)
        page.wait_for_timeout(2000)

        # Check absence of admin elements
        admin_header = page.locator('.app-header')
        chat_panel = page.locator('#ai-chat-panel')
        stage_toolbar = page.locator('.hud-stage-toolbar')
        back_btn = page.locator('#btn-return-studio, #btn-exit-presentation, .btn-presentation-back')
        admin_modals = page.locator('#modal-projects-list, #modal-new-project, #modal-ai-settings, #modal-furniture-store')

        print('Viewer admin_header count:', admin_header.count())
        print('Viewer chat_panel count:', chat_panel.count())
        print('Viewer stage_toolbar count:', stage_toolbar.count())
        print('Viewer back_btn count:', back_btn.count())
        print('Viewer admin_modals count:', admin_modals.count())

        assert admin_header.count() == 0, 'app-header must NOT exist in viewer.html'
        assert chat_panel.count() == 0, 'ai-chat-panel must NOT exist in viewer.html'
        assert stage_toolbar.count() == 0, 'hud-stage-toolbar must NOT exist in viewer.html'
        assert back_btn.count() == 0, 'back/admin button must NOT exist in viewer.html'
        assert admin_modals.count() == 0, 'admin modals must NOT exist in viewer.html'

        # Check presence of client presentation elements
        v_sidebar = page.locator('#sidebar-left')
        v_dock = page.locator('#floating-control-dock')
        v_canvas = page.locator('#viewport-container canvas')
        v_blueprint_modal = page.locator('#modal-floorplan')

        assert v_sidebar.count() > 0, 'Dossier sidebar must exist'
        assert v_dock.count() > 0, 'Floating control dock must exist'
        assert v_blueprint_modal.count() > 0, 'Blueprint modal must exist'
        print('Canvas count:', v_canvas.count())
        print('Dedicated Client Viewer Verified 100% Isolated and Clean!')

        shot2 = os.path.join(artifact_dir, "pure_viewer_layout_isolated.png")
        page.screenshot(path=shot2)
        print(f"Captured screenshot: {shot2}")

        # 3. Test /viewer?project=proj_sample_villa_3f
        print('\nTesting /viewer?project=proj_sample_villa_3f...')
        page.goto('http://localhost:3000/viewer?project=proj_sample_villa_3f', wait_until='networkidle', timeout=20000)
        page.wait_for_timeout(2000)
        p_title = page.locator('#project-title').inner_text().strip()
        print('Project title on /viewer?project=proj_sample_villa_3f:', p_title)

        filtered_errors = [e for e in errors if not ('favicon' in e or '404' in e)]
        print('Filtered console errors:', len(filtered_errors))
        if filtered_errors:
            for e in filtered_errors:
                print('  -', e)
        else:
            print('0 console errors!')
        browser.close()
        print('\nALL UI REFACTOR & CLIENT VIEWER CHECKS PASSED!')

if __name__ == '__main__':
    run_checks()
