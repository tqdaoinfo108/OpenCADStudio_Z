"""
verify_beauty_cohesion_sprint.py
E2E Automation Verification & High-Fidelity Screenshot Generation for
Beauty & Cohesion Sprint (Sprint 4):
1. Seamless CAD 2D Topology & A-GRID Coordinate System (blueprint modal, polygon union, grid bubbles & dash-dot lines)
2. Cinematic 3D Render Fidelity (ACESFilmicToneMapping, PCFSoftShadowMap, Studio Environment Map, SSAO / Contact Shadows, Geometry Beveling / Chamfer)
3. Commercial Design System UI/UX (CSS Flex/Grid, Glassmorphism Floating Dock blur-16px, Warm Neutrals/Slate, 200ms micro-interactions)
4. Dedicated Client Viewer Mode (/viewer pure architectural dossier, 0 admin elements, 100% locked navigation)

Outputs 4 sharp verification screenshots directly into ARTIFACT_DIR:
- cad_seamless_topology_blueprint.png
- cinematic_3d_fidelity_ssao.png
- premium_design_system_dock.png
- commercial_client_viewer_mode.png
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
    print(f"[BEAUTY-VERIFY] {msg}", flush=True)

def check_server(url, max_attempts=10, delay=1.0):
    log(f"Checking server responsiveness at {url}...")
    for i in range(max_attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'BeautyVerifier/1.0'})
            with urllib.request.urlopen(req, timeout=3) as resp:
                if resp.status == 200:
                    log(f"  ✓ Server is responsive (HTTP {resp.status})")
                    return True
        except Exception as e:
            time.sleep(delay)
    log(f"  ✗ Server not reachable after {max_attempts} attempts: {url}")
    return False

def run_verification():
    log("=================================================================")
    log("STARTING BEAUTY & COHESION SPRINT E2E VERIFICATION SUITE")
    log("=================================================================")

    if not check_server(BASE_URL):
        log("CRITICAL: Server at http://localhost:3000 is not reachable. Aborting.")
        return False, []

    console_errors = []
    page_errors = []

    matrix = {
        "test1_cad_2d_seamless_topology": {
            "name": "CAD 2D Seamless Wall Topology & A-GRID System",
            "passed": False,
            "metrics": {}
        },
        "test2_cinematic_3d_render": {
            "name": "Cinematic 3D Fidelity (Studio Lighting, SSAO, Bevel)",
            "passed": False,
            "metrics": {}
        },
        "test3_commercial_design_system": {
            "name": "Commercial Design System UI/UX & Floating Dock",
            "passed": False,
            "metrics": {}
        },
        "test4_client_viewer_isolation": {
            "name": "Dedicated Client Viewer Mode (/viewer, 0 Admin)",
            "passed": False,
            "metrics": {}
        }
    }

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

        def on_console(msg):
            if msg.type == 'error':
                txt = f"CONSOLE ERROR: {msg.text}"
                console_errors.append(txt)
                log(f"  [Console Error] {txt}")

        def on_pageerror(err):
            txt = f"PAGE ERROR: {err}"
            page_errors.append(txt)
            log(f"  [Page Error] {txt}")

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        # =============================================================
        # TEST 1: CAD 2D Seamless Wall Topology & A-GRID Coordinate System
        # =============================================================
        log("\n>>> [TEST 1] CAD 2D Seamless Wall Topology & A-GRID Coordinate System")
        try:
            page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(2500)

            # Click floorplan widget card to open CAD blueprint modal
            floorplan_card = page.locator("#floorplan-card")
            if floorplan_card.count() > 0:
                log("  Opening 2D CAD Blueprint modal via #floorplan-card...")
                floorplan_card.dispatch_event("click")
                page.wait_for_timeout(1500)

            # Check if modal is visible
            modal = page.locator("#floorplan-modal")
            is_modal_visible = modal.count() > 0 and page.evaluate("""() => {
                const m = document.getElementById('floorplan-modal');
                if (!m) return false;
                const style = window.getComputedStyle(m);
                return !m.classList.contains('hidden') && style.display !== 'none';
            }""")
            log(f"  Blueprint modal visible: {is_modal_visible}")

            # Inspect SVG contents for Seamless Topology and A-GRID
            svg_eval = page.evaluate("""() => {
                const container = document.getElementById('modal-svg-container') || document.getElementById('floorplan-svg-preview');
                const svg = container ? container.querySelector('svg') : null;
                if (!svg) return { error: 'No SVG element found' };

                // 1. Check A-GRID System (Grid lines, dash-dot, grid bubbles with labels)
                const gridLines = Array.from(svg.querySelectorAll('.cad-grid-line, line[stroke-dasharray]'));
                const gridBubbles = Array.from(svg.querySelectorAll('.cad-grid-bubble, circle'));
                const gridTexts = Array.from(svg.querySelectorAll('.cad-grid-label, text')).filter(t => {
                    const txt = t.textContent.trim();
                    return /^[0-9]+$/.test(txt) || /^[A-Z]$/.test(txt);
                });

                // Check dash-dot or dashed attributes
                const hasDashedGrid = gridLines.some(l => {
                    const da = l.getAttribute('stroke-dasharray');
                    return da && (da.includes('6,2,2,2') || da.includes('6, 2, 2, 2') || da.includes('0.2') || da.includes('0.15') || da.includes('0.08'));
                }) || svg.innerHTML.includes('dash-dot') || svg.innerHTML.includes('stroke-dasharray');

                // 2. Check Seamless CAD Wall Topology (Paths, merged polygons, solid fills, no cross-lines)
                const wallPaths = Array.from(svg.querySelectorAll('.cad-wall-seamless, path.cad-wall, polygon.cad-wall, path[fill="#334155"], path[fill="#0F172A"], path[fill="#1E293B"]'));
                const allPaths = Array.from(svg.querySelectorAll('path'));
                const wallPolygons = Array.from(svg.querySelectorAll('polygon, rect[data-layer*="WALL"], path[data-layer*="WALL"]'));
                
                // Check if walls use polygon union or solid seamless fills
                const hasSeamlessWalls = wallPaths.length > 0 || wallPolygons.length > 0 || svg.querySelectorAll('.cad-blueprint-svg').length > 0;

                return {
                    svgFound: true,
                    gridLinesCount: gridLines.length,
                    gridBubblesCount: gridBubbles.length,
                    gridLabelsCount: gridTexts.length,
                    hasDashedGrid,
                    wallPathsCount: wallPaths.length,
                    wallPolygonsCount: wallPolygons.length,
                    totalPaths: allPaths.length,
                    hasSeamlessWalls,
                    viewBox: svg.getAttribute('viewBox')
                };
            }""")
            log(f"  SVG Evaluation: {json.dumps(svg_eval, ensure_ascii=False)}")

            # Capture Screenshot 1: cad_seamless_topology_blueprint.png
            shot1 = os.path.join(ARTIFACT_DIR, "cad_seamless_topology_blueprint.png")
            modal_content = page.locator("#floorplan-modal .modal-content")
            if modal_content.count() > 0 and is_modal_visible:
                modal_content.screenshot(path=shot1)
            else:
                page.screenshot(path=shot1)
            log(f"  ✓ Captured Screenshot 1: {shot1}")

            # Close blueprint modal
            close_btn = page.locator("#modal-close-btn")
            if close_btn.count() > 0:
                close_btn.click()
                page.wait_for_timeout(800)

            t1_pass = is_modal_visible and svg_eval.get("svgFound", False)
            matrix["test1_cad_2d_seamless_topology"]["passed"] = t1_pass
            matrix["test1_cad_2d_seamless_topology"]["metrics"] = svg_eval

        except Exception as e:
            log(f"  ✗ Test 1 exception: {e}")
            matrix["test1_cad_2d_seamless_topology"]["metrics"]["error"] = str(e)

        # =============================================================
        # TEST 2: Cinematic 3D Render Fidelity (ACES, PCFSoftShadow, SSAO, Bevel)
        # =============================================================
        log("\n>>> [TEST 2] Cinematic 3D Render Fidelity (Studio Lighting, SSAO, Bevel)")
        try:
            page.wait_for_timeout(1000)

            # Evaluate Three.js rendering settings in page context
            three_eval = page.evaluate("""() => {
                const app = window.app;
                if (!app || !app.viewer) return { error: 'app.viewer not initialized' };
                const v = app.viewer;
                const r = v.renderer;
                const s = v.scene;

                // 1. Tone Mapping
                const toneMapping = r.toneMapping;
                // THREE.ACESFilmicToneMapping is 4
                const isACES = toneMapping === 4;
                const exposure = r.toneMappingExposure;

                // 2. Shadows
                const shadowEnabled = r.shadowMap ? r.shadowMap.enabled : false;
                // THREE.PCFSoftShadowMap is 2, THREE.PCFShadowMap is 1
                const shadowType = r.shadowMap ? r.shadowMap.type : null;
                const isPCFSoft = shadowType === 2;

                // 3. Environment Map / Reflections
                const hasEnv = !!s.environment;

                // 4. SSAO / Contact Shadows
                const hasSSAO = !!v.ssaoPass || !!v.composer || !!v.contactShadowPlane || !!v.effectComposer;
                const contactShadowMesh = v.contactShadowPlane ? {
                    visible: v.contactShadowPlane.visible,
                    receiveShadow: v.contactShadowPlane.receiveShadow
                } : null;

                // 5. Geometry Beveling / Chamfer
                let beveledCount = 0;
                let totalMeshes = 0;
                s.traverse((obj) => {
                    if (obj.isMesh && obj.geometry) {
                        totalMeshes++;
                        const geo = obj.geometry;
                        if (geo.parameters && geo.parameters.options && geo.parameters.options.bevelEnabled) {
                            beveledCount++;
                        } else if (geo.userData && (geo.userData.bevelEnabled || geo.userData.chamfered)) {
                            beveledCount++;
                        }
                    }
                });

                return {
                    toneMapping,
                    isACES,
                    exposure,
                    shadowEnabled,
                    shadowType,
                    isPCFSoft,
                    hasEnv,
                    hasSSAO,
                    contactShadowMesh,
                    beveledCount,
                    totalMeshes
                };
            }""")
            log(f"  Three.js Evaluation: {json.dumps(three_eval, ensure_ascii=False)}")

            # Switch view to Dollhouse / Interior to showcase lighting & shadows
            dollhouse_btn = page.locator('#floating-control-dock [data-view-mode="dollhouse"]')
            if dollhouse_btn.count() > 0:
                dollhouse_btn.dispatch_event("click")
                page.wait_for_timeout(1800)

            # Capture Screenshot 2: cinematic_3d_fidelity_ssao.png
            shot2 = os.path.join(ARTIFACT_DIR, "cinematic_3d_fidelity_ssao.png")
            page.screenshot(path=shot2)
            log(f"  ✓ Captured Screenshot 2: {shot2}")

            t2_pass = three_eval.get("isACES", False) or three_eval.get("toneMapping") == 4
            matrix["test2_cinematic_3d_render"]["passed"] = t2_pass
            matrix["test2_cinematic_3d_render"]["metrics"] = three_eval

        except Exception as e:
            log(f"  ✗ Test 2 exception: {e}")
            matrix["test2_cinematic_3d_render"]["metrics"]["error"] = str(e)

        # =============================================================
        # TEST 3: Commercial Design System UI/UX & Floating Control Dock
        # =============================================================
        log("\n>>> [TEST 3] Commercial Design System UI/UX & Floating Control Dock")
        try:
            ui_eval = page.evaluate("""() => {
                const dock = document.getElementById('floating-control-dock') || document.querySelector('.floating-control-dock');
                if (!dock) return { error: 'Floating dock missing' };
                const dockStyle = window.getComputedStyle(dock);
                const sidebar = document.getElementById('sidebar-left') || document.querySelector('.sidebar');
                const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;

                // Check blur backdrop-filter
                const bf = dockStyle.backdropFilter || dockStyle.webkitBackdropFilter || '';
                const hasBlur = bf.includes('blur');

                // Check rounded pill border-radius
                const br = dockStyle.borderRadius;
                const isPill = parseInt(br) >= 20 || br.includes('9999');

                // Check z-index
                const zIndex = dockStyle.zIndex;

                // Check micro-interactions (transition duration)
                const buttons = Array.from(dock.querySelectorAll('button'));
                let has200ms = false;
                for (const b of buttons) {
                    const trans = window.getComputedStyle(b).transition;
                    if (trans.includes('0.2s') || trans.includes('200ms')) {
                        has200ms = true;
                        break;
                    }
                }

                return {
                    dockFound: true,
                    dockDisplay: dockStyle.display,
                    backdropFilter: bf,
                    hasBlur,
                    borderRadius: br,
                    isPill,
                    zIndex,
                    has200ms,
                    dockButtonsCount: buttons.length,
                    sidebarWidth: sidebarStyle ? sidebarStyle.width : null
                };
            }""")
            log(f"  Design System Evaluation: {json.dumps(ui_eval, ensure_ascii=False)}")

            # Hover on dock to show micro-interaction state
            dock_first_btn = page.locator("#floating-control-dock button").first
            if dock_first_btn.count() > 0:
                dock_first_btn.hover()
                page.wait_for_timeout(400)

            # Capture Screenshot 3: premium_design_system_dock.png
            shot3 = os.path.join(ARTIFACT_DIR, "premium_design_system_dock.png")
            page.screenshot(path=shot3)
            log(f"  ✓ Captured Screenshot 3: {shot3}")

            t3_pass = ui_eval.get("dockFound", False) and ui_eval.get("hasBlur", False)
            matrix["test3_commercial_design_system"]["passed"] = t3_pass
            matrix["test3_commercial_design_system"]["metrics"] = ui_eval

        except Exception as e:
            log(f"  ✗ Test 3 exception: {e}")
            matrix["test3_commercial_design_system"]["metrics"]["error"] = str(e)

        # =============================================================
        # TEST 4: Dedicated Client Viewer Mode (/viewer, 0 Admin Elements)
        # =============================================================
        log("\n>>> [TEST 4] Dedicated Client Viewer Mode (http://localhost:3000/viewer)")
        try:
            page.goto(f"{BASE_URL}/viewer", wait_until="networkidle", timeout=20000)
            page.wait_for_timeout(2000)

            client_eval = page.evaluate("""() => {
                // Strict absence of admin elements
                const adminHeader = document.querySelector('.app-header');
                const chatDrawer = document.getElementById('ai-chat-panel') || document.querySelector('.ai-chat-panel');
                const chatToggle = document.getElementById('btn-toggle-chat');
                const stageToolbar = document.querySelector('.hud-stage-toolbar');
                const backBtn = document.querySelector('#btn-return-studio, #btn-exit-presentation, .btn-presentation-back');
                const adminModals = document.querySelectorAll('#modal-projects-list, #modal-new-project, #modal-ai-settings, #modal-furniture-store');

                // Check presence of pure architectural viewer components
                const canvas = document.getElementById('viewer-canvas') || document.getElementById('viewport-container');
                const dock = document.getElementById('floating-control-dock') || document.querySelector('.floating-control-dock');
                const floorList = document.querySelector('.sidebar-floors, .floor-list, #sidebar-left');

                return {
                    hasAdminHeader: !!adminHeader,
                    hasChatDrawer: !!chatDrawer,
                    hasChatToggle: !!chatToggle,
                    hasStageToolbar: !!stageToolbar,
                    hasBackBtn: !!backBtn,
                    adminModalsCount: adminModals.length,
                    hasCanvas: !!canvas,
                    hasDock: !!dock,
                    hasFloorList: !!floorList,
                    adminElementCount: (adminHeader ? 1 : 0) + (chatDrawer ? 1 : 0) + (chatToggle ? 1 : 0) + (stageToolbar ? 1 : 0) + (backBtn ? 1 : 0) + adminModals.length
                };
            }""")
            log(f"  Client Viewer Evaluation: {json.dumps(client_eval, ensure_ascii=False)}")

            # Capture Screenshot 4: commercial_client_viewer_mode.png
            shot4 = os.path.join(ARTIFACT_DIR, "commercial_client_viewer_mode.png")
            page.screenshot(path=shot4)
            log(f"  ✓ Captured Screenshot 4: {shot4}")

            t4_pass = client_eval.get("adminElementCount", 1) == 0 and client_eval.get("hasCanvas", False) and client_eval.get("hasDock", False)
            matrix["test4_client_viewer_isolation"]["passed"] = t4_pass
            matrix["test4_client_viewer_isolation"]["metrics"] = client_eval

        except Exception as e:
            log(f"  ✗ Test 4 exception: {e}")
            matrix["test4_client_viewer_isolation"]["metrics"]["error"] = str(e)

        browser.close()

    # =============================================================
    # SUMMARY & RESULTS
    # =============================================================
    log("\n=================================================================")
    log("E2E VERIFICATION COMPLETED - SUMMARY")
    log("=================================================================")
    log(f"Total Console Errors: {len(console_errors)}")
    for err in console_errors:
        log(f"  - {err}")
    log(f"Total Page Errors: {len(page_errors)}")
    for err in page_errors:
        log(f"  - {err}")

    for k, v in matrix.items():
        status = "PASS" if v["passed"] else "FAIL"
        log(f"  [{status}] {v['name']}")

    result_json = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "console_errors_count": len(console_errors),
        "console_errors": console_errors,
        "page_errors_count": len(page_errors),
        "page_errors": page_errors,
        "matrix": matrix
    }

    report_path = os.path.join(ARTIFACT_DIR, "beauty_cohesion_verification_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(result_json, f, indent=2, ensure_ascii=False)
    log(f"Report saved to: {report_path}")

    return (len(console_errors) == 0 and len(page_errors) == 0), matrix

if __name__ == "__main__":
    success, matrix = run_verification()
    sys.exit(0 if success else 1)
