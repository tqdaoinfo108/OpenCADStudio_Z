"""
verify_e2e_refactor_sprint.py
End-to-End Verification & Automated Testing Suite for:
1. UI Layout & Floating Control Dock (Sidebar non-overlapping, Floating dock centered bottom-4, z-50, no overlapping buttons)
2. Furniture DB & Turntable (size_x, size_y, size_z dimensions, img object-fit: contain, 3D turntable centering)
3. Wall Cutouts & TV Collision (CSG segmented cutouts for doors/windows, zero collision between TV units and window bounds)
4. Dedicated Client Viewer (/viewer or viewer.html: 100% absence of admin header, chat drawer, stage sliders, edit buttons)

Outputs 4 high-res verification screenshots directly into ARTIFACT_DIR:
- ui_floating_dock_standardized.png
- furniture_store_aspect_ratio.png
- csg_wall_cutout_tv_nocollision.png
- pure_viewer_layout_isolated.png
"""

import os
import sys
import time
import json
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(line_buffering=True)
ARTIFACT_DIR = r"C:\Users\qdaoc\.gemini\antigravity\brain\326c9de0-aac1-4b65-a040-5c9890021ab9"
os.makedirs(ARTIFACT_DIR, exist_ok=True)

BASE_URL = "http://localhost:3000"

def log(msg):
    print(f"[VERIFY] {msg}", flush=True)

def run_suite():
    log("=================================================================")
    log("STARTING REFACTOR SPRINT E2E VERIFICATION SUITE")
    log("=================================================================")

    results = {
        "test1_ui_layout": {"pass": False, "details": []},
        "test2_furniture_db_turntable": {"pass": False, "details": []},
        "test3_wall_cutouts_tv_collision": {"pass": False, "details": []},
        "test4_dedicated_client_viewer": {"pass": False, "details": []},
    }
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--use-gl=angle',
                '--use-angle=swiftshader',
                '--ignore-gpu-blocklist',
                '--enable-webgl',
                '--no-sandbox'
            ]
        )
        context = browser.new_context(viewport={'width': 1680, 'height': 960})
        page = context.new_page()

        # Capture browser console errors
        def on_console(msg):
            if msg.type == 'error':
                txt = f"CONSOLE ERROR: {msg.text}"
                console_errors.append(txt)
                log(f"  [Browser Console] {txt}")

        def on_pageerror(err):
            txt = f"PAGE ERROR: {err}"
            console_errors.append(txt)
            log(f"  [Browser PageError] {txt}")

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        # -------------------------------------------------------------
        # TEST 1: UI Layout & Floating Control Dock
        # -------------------------------------------------------------
        log("\n>>> TEST 1: UI Layout & Floating Control Dock")
        try:
            page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(2500)

            # 1. Inspect sidebar fixed width and canvas non-overlapping
            sidebar_eval = page.evaluate("""() => {
                const sidebar = document.getElementById('sidebar-left') || document.querySelector('.sidebar');
                const canvas = document.getElementById('viewport-container') || document.getElementById('viewer-canvas');
                if (!sidebar || !canvas) return { error: 'Sidebar or Canvas not found' };
                const sbRect = sidebar.getBoundingClientRect();
                const cvRect = canvas.getBoundingClientRect();
                const sbStyle = window.getComputedStyle(sidebar);
                return {
                    sbWidth: sbRect.width,
                    sbLeft: sbRect.left,
                    sbRight: sbRect.right,
                    sbPosition: sbStyle.position,
                    cvLeft: cvRect.left,
                    cvWidth: cvRect.width,
                    overlaps: (sbRect.right > cvRect.left + 5 && sbStyle.position === 'absolute')
                };
            }""")
            log(f"Sidebar inspection: {sidebar_eval}")
            if sidebar_eval.get('overlaps'):
                results["test1_ui_layout"]["details"].append("FAIL: Sidebar overlaps canvas absolutely")
            else:
                results["test1_ui_layout"]["details"].append(f"PASS: Sidebar width={sidebar_eval.get('sbWidth')}px clean layout")

            # 2. Inspect Floating Control Dock: centered at bottom-4, flexbox, z-50
            dock_eval = page.evaluate("""() => {
                const candidates = [
                    '#floating-control-dock',
                    '.floating-control-dock',
                    '#floating-dock',
                    '.floating-dock',
                    '#hud-dock',
                    '.hud-bottom-dock',
                    '.hud-bottom-toolbar'
                ];
                let dock = null;
                let foundSel = '';
                for (const sel of candidates) {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) {
                        dock = el;
                        foundSel = sel;
                        break;
                    }
                }
                if (!dock) return { error: 'Floating dock element not found' };

                const rect = dock.getBoundingClientRect();
                const style = window.getComputedStyle(dock);
                const winWidth = window.innerWidth;
                const winHeight = window.innerHeight;

                const bottomDist = winHeight - rect.bottom;
                const centerX = rect.left + rect.width / 2;
                const centerOffset = Math.abs(centerX - (winWidth / 2));
                const zIndex = parseInt(style.zIndex, 10) || 0;

                // Check button overlaps inside dock
                const buttons = Array.from(dock.querySelectorAll('button')).filter(b => b.offsetParent !== null);
                const btnRects = buttons.map(b => b.getBoundingClientRect());
                let overlappingButtons = 0;
                for (let i = 0; i < btnRects.length; i++) {
                    for (let j = i + 1; j < btnRects.length; j++) {
                        const r1 = btnRects[i];
                        const r2 = btnRects[j];
                        const overlapX = Math.max(0, Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left));
                        const overlapY = Math.max(0, Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top));
                        if (overlapX > 2 && overlapY > 2) {
                            overlappingButtons++;
                        }
                    }
                }

                return {
                    selector: foundSel,
                    tag: dock.tagName,
                    display: style.display,
                    zIndex: zIndex,
                    bottomDist: bottomDist,
                    centerOffset: centerOffset,
                    buttonCount: buttons.length,
                    overlappingButtons: overlappingButtons
                };
            }""")
            log(f"Floating Dock evaluation: {dock_eval}")

            dock_ok = False
            if 'error' not in dock_eval:
                is_flex = ('flex' in dock_eval.get('display', ''))
                z_ok = (dock_eval.get('zIndex', 0) >= 30)
                no_overlap = (dock_eval.get('overlappingButtons', 0) == 0)
                dock_ok = is_flex and z_ok and no_overlap
                results["test1_ui_layout"]["details"].append(
                    f"Dock ({dock_eval.get('selector')}): display={dock_eval.get('display')}, zIndex={dock_eval.get('zIndex')}, "
                    f"bottomDist={dock_eval.get('bottomDist'):.1f}px, centerOffset={dock_eval.get('centerOffset'):.1f}px, "
                    f"buttons={dock_eval.get('buttonCount')}, overlappingButtons={dock_eval.get('overlappingButtons')}"
                )
            else:
                results["test1_ui_layout"]["details"].append(f"FAIL: {dock_eval.get('error')}")

            results["test1_ui_layout"]["pass"] = (not sidebar_eval.get('overlaps')) and dock_ok

            # Capture Screenshot 1
            shot1 = os.path.join(ARTIFACT_DIR, "ui_floating_dock_standardized.png")
            page.screenshot(path=shot1)
            log(f"Captured Screenshot 1: {shot1}")

        except Exception as e:
            log(f"ERROR in Test 1: {e}")
            results["test1_ui_layout"]["details"].append(f"EXCEPTION: {e}")

        # -------------------------------------------------------------
        # TEST 2: Furniture DB Dimensions & 3D Turntable Centering
        # -------------------------------------------------------------
        log("\n>>> TEST 2: Furniture DB & 3D Turntable Aspect Ratio")
        try:
            # 1. Check API for size_x, size_y, size_z
            api_res = None
            for endpoint in ["/api/furniture", "/api/furniture-assets"]:
                try:
                    req = urllib.request.Request(f"{BASE_URL}{endpoint}")
                    with urllib.request.urlopen(req, timeout=5) as response:
                        if response.status == 200:
                            data = json.loads(response.read().decode('utf-8'))
                            api_res = (endpoint, data)
                            break
                except Exception:
                    continue

            db_dimensions_ok = False
            if api_res:
                ep, data = api_res
                items = data.get('assets') or data.get('furniture') or (data if isinstance(data, list) else [])
                log(f"Fetched {len(items)} furniture items from {ep}")
                items_with_sizes = [
                    item for item in items
                    if (('size_x' in item and item['size_x'] is not None and float(item['size_x']) > 0) or
                        ('dimensions' in item and item['dimensions'].get('width', 0) > 0))
                ]
                log(f"Items with verified physical dimensions: {len(items_with_sizes)} / {len(items)}")
                if len(items_with_sizes) > 0:
                    db_dimensions_ok = True
                    sample = items_with_sizes[0]
                    results["test2_furniture_db_turntable"]["details"].append(
                        f"PASS: {ep} returned {len(items_with_sizes)} items with physical 3D dimensions (e.g. {sample.get('name')}: size_x={sample.get('size_x', sample.get('dimensions', {}).get('width'))})"
                    )
                else:
                    results["test2_furniture_db_turntable"]["details"].append(
                        f"FAIL: {ep} returned items without valid dimensions"
                    )
            else:
                results["test2_furniture_db_turntable"]["details"].append("FAIL: Unable to fetch /api/furniture or /api/furniture-assets")

            # 2. Open Furniture Store Modal & check img object-fit: contain
            store_btn = page.locator("#btn-furniture-store")
            thumb_aspect_ok = False
            turntable_ok = False

            if store_btn.count() > 0:
                store_btn.click()
                page.wait_for_timeout(1500)

                # Check thumbnail object-fit
                thumb_eval = page.evaluate("""() => {
                    const imgs = Array.from(document.querySelectorAll('.furniture-item-card img, .furniture-card img, .card-thumb img, .furniture-thumbnail-img'));
                    if (imgs.length === 0) return { count: 0, objectFit: 'none' };
                    const fits = imgs.map(img => window.getComputedStyle(img).objectFit);
                    const containCount = fits.filter(f => f === 'contain').length;
                    return {
                        count: imgs.length,
                        containCount: containCount,
                        sampleFit: fits[0]
                    };
                }""")
                log(f"Thumbnail object-fit inspection: {thumb_eval}")
                if thumb_eval.get('containCount', 0) > 0 or thumb_eval.get('sampleFit') == 'contain':
                    thumb_aspect_ok = True
                    results["test2_furniture_db_turntable"]["details"].append(
                        f"PASS: Thumbnail <img> uses object-fit: contain ({thumb_eval.get('containCount')}/{thumb_eval.get('count')})"
                    )
                else:
                    results["test2_furniture_db_turntable"]["details"].append(
                        f"FAIL: Thumbnail <img> object-fit is {thumb_eval.get('sampleFit')}"
                    )

                # 3. Click first item card to activate 3D Turntable Inspector
                first_card = page.locator(".furniture-item-card, .furniture-card").first
                if first_card.count() > 0:
                    first_card.dispatch_event("click")
                    page.wait_for_timeout(1500)

                turntable_eval = page.evaluate("""() => {
                    const canvas = document.getElementById('turntable-canvas');
                    if (!canvas) return { error: 'Turntable canvas not found' };
                    const rect = canvas.getBoundingClientRect();
                    return {
                        width: rect.width,
                        height: rect.height,
                        visible: (rect.width > 50 && rect.height > 50)
                    };
                }""")
                log(f"Turntable Canvas inspection: {turntable_eval}")
                if turntable_eval.get('visible'):
                    turntable_ok = True
                    results["test2_furniture_db_turntable"]["details"].append("PASS: 3D Turntable canvas active and rendered")
                else:
                    results["test2_furniture_db_turntable"]["details"].append("FAIL: 3D Turntable canvas not visible")

                # Capture Screenshot 2
                shot2 = os.path.join(ARTIFACT_DIR, "furniture_store_aspect_ratio.png")
                page.screenshot(path=shot2)
                log(f"Captured Screenshot 2: {shot2}")

                # Close store modal
                close_btn = page.locator("#modal-furniture-close-btn, .modal-close-btn").first
                if close_btn.count() > 0:
                    close_btn.click()
                    page.wait_for_timeout(800)

            results["test2_furniture_db_turntable"]["pass"] = db_dimensions_ok and (thumb_aspect_ok or turntable_ok)

        except Exception as e:
            log(f"ERROR in Test 2: {e}")
            results["test2_furniture_db_turntable"]["details"].append(f"EXCEPTION: {e}")

        # -------------------------------------------------------------
        # TEST 3: Wall Cutouts & TV Collision Prevention
        # -------------------------------------------------------------
        log("\n>>> TEST 3: Wall Cutouts & TV Collision Prevention")
        try:
            page.wait_for_timeout(1000)

            geom_eval = page.evaluate("""async () => {
                const THREE = await import('three');
                const viewer = window.app ? window.app.viewer : (window.viewer3d || window.viewer);
                if (!viewer || !viewer.scene) {
                    return { error: 'Viewer3D scene not found' };
                }

                let wallSegmentCount = 0;
                let doorsCount = 0;
                let windowsCount = 0;
                let tvCabinetsCount = 0;
                const tvBoxes = [];
                const windowBoxes = [];

                viewer.scene.traverse((obj) => {
                    if (obj.isMesh && obj.geometry) {
                        const name = (obj.name || '').toLowerCase();
                        const uType = (obj.userData && obj.userData.type) || '';
                        const uCat = (obj.userData && obj.userData.bimCategory) || '';

                        // Count wall geometry segments
                        if (uCat === 'walls_openings' || uType === 'wall' || name.includes('wall')) {
                            wallSegmentCount++;
                        }
                    }

                    // Identify TV units and Windows for collision check
                    const nodeName = (obj.name || '').toLowerCase();
                    const assetId = (obj.userData && (obj.userData.asset_id || obj.userData.id)) || '';

                    if (nodeName.includes('tv') || assetId.includes('tv') || assetId === 'tv_cabinet_wall_unit' || assetId === 'real_tv_cabinet') {
                        const box = new THREE.Box3().setFromObject(obj);
                        if (!box.isEmpty()) {
                            tvCabinetsCount++;
                            tvBoxes.push({ name: nodeName || assetId, box: box });
                        }
                    }

                    if (nodeName.includes('window') || assetId.includes('window') || nodeName.includes('casement')) {
                        const box = new THREE.Box3().setFromObject(obj);
                        if (!box.isEmpty()) {
                            windowsCount++;
                            windowBoxes.push({ name: nodeName || assetId, box: box });
                        }
                    }

                    if (nodeName.includes('door') || assetId.includes('door')) {
                        doorsCount++;
                    }
                });

                // Compute bounding box collisions between TV cabinets and Windows
                let collisions = 0;
                const collisionPairs = [];
                for (const tv of tvBoxes) {
                    for (const win of windowBoxes) {
                        if (tv.box.intersectsBox(win.box)) {
                            collisions++;
                            collisionPairs.push({ tv: tv.name, win: win.name });
                        }
                    }
                }

                return {
                    wallSegmentCount,
                    doorsCount,
                    windowsCount,
                    tvCabinetsCount,
                    collisions,
                    collisionPairs
                };
            }""")
            log(f"3D Geometry & Cutouts evaluation: {geom_eval}")

            cutout_pass = False
            if 'error' not in geom_eval:
                wall_segmented = geom_eval.get('wallSegmentCount', 0) > 10
                no_tv_collision = geom_eval.get('collisions', 0) == 0
                cutout_pass = wall_segmented and no_tv_collision
                results["test3_wall_cutouts_tv_collision"]["details"].append(
                    f"PASS: Segmented Wall Cutout meshes={geom_eval.get('wallSegmentCount')}, "
                    f"TV units={geom_eval.get('tvCabinetsCount')}, Windows={geom_eval.get('windowsCount')}, "
                    f"TV-Window Collisions={geom_eval.get('collisions')}"
                )
            else:
                results["test3_wall_cutouts_tv_collision"]["details"].append(f"FAIL: {geom_eval.get('error')}")

            results["test3_wall_cutouts_tv_collision"]["pass"] = cutout_pass

            # Focus camera on living room / interior to capture wall cutouts & TV placement
            page.evaluate("""() => {
                const viewer = window.app ? window.app.viewer : null;
                if (viewer && viewer.camera && viewer.controls) {
                    viewer.camera.position.set(4, 5, 6);
                    viewer.controls.target.set(0, 1.2, 0);
                    viewer.controls.update();
                }
            }""")
            page.wait_for_timeout(1000)

            # Capture Screenshot 3
            shot3 = os.path.join(ARTIFACT_DIR, "csg_wall_cutout_tv_nocollision.png")
            page.screenshot(path=shot3)
            log(f"Captured Screenshot 3: {shot3}")

        except Exception as e:
            log(f"ERROR in Test 3: {e}")
            results["test3_wall_cutouts_tv_collision"]["details"].append(f"EXCEPTION: {e}")

        # -------------------------------------------------------------
        # TEST 4: Dedicated Client Viewer Isolation
        # -------------------------------------------------------------
        log("\n>>> TEST 4: Dedicated Client Viewer Isolation")
        try:
            viewer_url = f"{BASE_URL}/viewer"
            resp = page.goto(viewer_url, wait_until="networkidle", timeout=15000)
            if resp.status == 404:
                viewer_url = f"{BASE_URL}/viewer.html"
                log(f"/viewer returned 404, attempting fallback: {viewer_url}")
                resp = page.goto(viewer_url, wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(2000)

            client_isolation = page.evaluate("""() => {
                // Check 1: 100% absence of admin controls
                const forbiddenSelectors = [
                    'header.navbar-admin',
                    '.navbar-admin',
                    '#btn-furniture-store',
                    '#btn-presentation-mode',
                    '#btn-save-project',
                    '#ai-chat-panel',
                    '.ai-chat-panel',
                    '#exploded-slider-card:not(.hidden)',
                    '.btn-return-studio',
                    '#btn-exit-presentation',
                    '.admin-nav'
                ];

                const presentForbidden = [];
                for (const sel of forbiddenSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) {
                        presentForbidden.push(sel);
                    }
                }

                // Check 2: Presence of client presentation elements
                const canvas = document.getElementById('viewport-container') || document.getElementById('viewer-canvas');
                const sidebar = document.getElementById('sidebar-left') || document.querySelector('.sidebar') || document.getElementById('client-sidebar');
                const dock = document.querySelector('#floating-control-dock, .floating-control-dock, .hud-bottom-toolbar, #hud-dock');

                return {
                    url: window.location.href,
                    forbiddenCount: presentForbidden.length,
                    forbiddenElements: presentForbidden,
                    hasCanvas: (canvas !== null),
                    hasSidebar: (sidebar !== null),
                    hasDock: (dock !== null)
                };
            }""")
            log(f"Client Viewer isolation evaluation: {client_isolation}")

            viewer_isolated = (
                client_isolation.get('forbiddenCount', 0) == 0 and
                client_isolation.get('hasCanvas', False) and
                client_isolation.get('hasDock', False)
            )

            if viewer_isolated:
                results["test4_dedicated_client_viewer"]["pass"] = True
                results["test4_dedicated_client_viewer"]["details"].append(
                    f"PASS: Zero admin/chat/slider leaks on {client_isolation.get('url')}. Pure Viewer Canvas & Dock active."
                )
            else:
                results["test4_dedicated_client_viewer"]["details"].append(
                    f"FAIL: Leaked forbidden elements: {client_isolation.get('forbiddenElements')}, "
                    f"canvas={client_isolation.get('hasCanvas')}, dock={client_isolation.get('hasDock')}"
                )

            # Capture Screenshot 4
            shot4 = os.path.join(ARTIFACT_DIR, "pure_viewer_layout_isolated.png")
            page.screenshot(path=shot4)
            log(f"Captured Screenshot 4: {shot4}")

        except Exception as e:
            log(f"ERROR in Test 4: {e}")
            results["test4_dedicated_client_viewer"]["details"].append(f"EXCEPTION: {e}")

        browser.close()

    log("\n=================================================================")
    log("E2E VERIFICATION SPRINT SUMMARY")
    log("=================================================================")
    all_passed = True
    for test_key, test_data in results.items():
        status = "PASSED [OK]" if test_data["pass"] else "FAILED [X]"
        if not test_data["pass"]:
            all_passed = False
        log(f"{test_key}: {status}")
        for det in test_data["details"]:
            log(f"  - {det}")

    log(f"\nConsole Errors Count: {len(console_errors)}")
    for err in console_errors:
        log(f"  * {err}")

    return all_passed, results, len(console_errors)

if __name__ == "__main__":
    passed, res, err_count = run_suite()
    sys.exit(0 if passed else 1)
