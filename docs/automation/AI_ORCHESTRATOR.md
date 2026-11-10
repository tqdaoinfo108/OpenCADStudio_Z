# Autonomous AI CAD worker

`ocs-ai-worker` is a separate native Rust workspace binary. It uses the real
OpenAI-compatible Chat Completions API and the real `OpenCADStudio --mcp`
stdio bridge; it does not link the GUI into the daemon or simulate CAD/tool
responses. SQLite is the local submission queue and durable event journal.

**Scope:** architectural concept/design automation within the parametric
solver's supported geometry. A passing geometric/file/vision audit is **not**
a structural, fire, accessibility, planning-permission or building-code
certification. A qualified AEC professional must review delivered drawings.
The service never labels an exhausted or unverifiable job successful.

## Build and prerequisites

```powershell
cargo build --workspace
cargo test --workspace -- --test-threads=1
cargo run -p ocs-ai-worker -- --help
```

Use a current native OpenCADStudio build with the documented 20 MCP tools,
protocol-1 batch bindings, typed entity creation, kernel measurements, PNG
capture and verified save. A graphical desktop/GPU (or a working virtual
Linux desktop) is required. `--serve` is useful for headless geometry tests,
but **cannot provide the actual viewport PNG required for Vision QA**; it is
not used as a silent replacement for MCP.

Do not run a Windows rendering worker as a Session-0/LocalSystem service.
Use a dedicated logged-in desktop user and preferably dedicated editor
sessions. Close unrelated modal dialogs manually. The bridge only dismisses
known association/donation startup prompts; it does not dismiss arbitrary
user dialogs. With multiple discovered editors, specify `--session` rather
than relying on the order of discovery.

## Configuration

Inject credentials through the process environment or a protected secret
manager. Never put keys in prompts, job JSON, the repository or task scripts.
The worker does not create or read a repository `.env` file.

| Variable | Default / purpose |
|---|---|
| `OPENAI_API_KEY` | Required; Bearer authentication; never written to artifacts |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1`; also accepts a full `/chat/completions` URL |
| `OPENAI_MODEL` | `gpt-4o`; structured planner, DEV function calling, evolution |
| `OPENAI_VISION_MODEL` | Same as `OPENAI_MODEL`; must accept actual PNG image input |
| `OCS_AI_HTTP_TIMEOUT_SECONDS` | `300`; 10–1800 seconds per HTTP attempt |
| `OCS_AI_MAX_COMPLETION_TOKENS` | `12000`; per completion |
| `OCS_EXECUTABLE` | Absolute path to the native CAD executable |
| `OCS_AI_QUEUE` | `target/ai-worker/jobs.sqlite` |

Example for a local OpenAI-compatible endpoint (key supplied separately):

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:55790/v1/chat/completions'
$env:OPENAI_MODEL = 'gpt-6.1-sol'
$env:OPENAI_VISION_MODEL = 'gpt-6.1-sol'
$env:OCS_EXECUTABLE = (Resolve-Path target/debug/OpenCADStudio.exe).Path

# Verifies actual MCP discovery and makes a real structured OpenAI request.
cargo run -p ocs-ai-worker -- check --executable $env:OCS_EXECUTABLE --openai
```

Remote endpoints require HTTPS; plain HTTP is restricted to loopback. The
endpoint must implement `response_format.type=json_schema`, function calling
and image input. The worker fails explicitly on a refusal, incomplete JSON,
truncation, unsupported models or invalid schema output. It does not silently
substitute a weaker JSON mode or a different provider/model. HTTP network,
429 and 5xx failures have a bounded retry/backoff; CAD mutation failures are
handled differently, as described below. API calls consume real tokens.

## Submit and operate

```powershell
# Returns a job_id. Submission itself does not spend API tokens.
cargo run -p ocs-ai-worker -- submit `
  --prompt 'Design a 6000 by 8000 mm one-storey house with living room and kitchen, doors, 2D plans, real 3D solids, a flat roof and dimensions.' `
  --format dxf --version 2000 `
  --output C:/CAD/AI-deliveries

# Foreground daemon; sleeps while the durable queue is empty.
cargo run -p ocs-ai-worker -- daemon --executable $env:OCS_EXECUTABLE

# Claim at most one job and return a failing exit code if that job fails.
cargo run -p ocs-ai-worker -- daemon --executable $env:OCS_EXECUTABLE --once

cargo run -p ocs-ai-worker -- status JOB_ID --events
cargo run -p ocs-ai-worker -- cancel JOB_ID
```

A custom database is a **global argument**, before the subcommand:

```powershell
ocs-ai-worker --database C:/CAD/queue/jobs.sqlite submit --prompt 'A compact studio' --output C:/CAD/deliveries
ocs-ai-worker --database C:/CAD/queue/jobs.sqlite daemon --executable C:/CAD/OpenCADStudio.exe
```

To develop an existing drawing, add `--input C:/CAD/source.dwg` to `submit`.
The path must exist and be DWG/DXF. The worker opens the source and writes a
separate verified delivery under the job's UUID directory; it never issues
an agent-directed save over the original path. Use an isolated editor, not a
person's active drawing. An input already open in that editor is refused.
Relative XREF/image dependencies still need to resolve from the source's
original directory.

Job controls: `--max-corrections 2` bounds repair iterations per QA phase;
`--max-evolution-steps 3` bounds additional development phases. Each is capped
at 10. Daemon controls: `--timeout-seconds 300`, `--max-tool-rounds 24` (max 64),
`--poll-seconds 2`. There is no unbounded LLM recursion. Inspect failures
rather than repeatedly resubmitting an impossible brief.

### Process/session pool

```powershell
ocs-ai-worker daemon --executable C:/CAD/OpenCADStudio.exe `
  --session FIRST_EDITOR_SESSION_ID --session SECOND_EDITOR_SESSION_ID
```

Each slot has its own MCP bridge, one pinned editor, serial mutations, and
one leased job at a time. Up to eight **distinct explicitly selected** editor
sessions are supported. Without session arguments, there is one slot; it
launches an editor if none exists and refuses ambiguous discovery. The
queue's OS file lock prevents two daemons from owning the same queue.
Do not point other queues/controllers at the same editor concurrently.
A user's document/tab switch causes a refusal rather than silently retargeting
mutations. Session-descriptor stale-process cleanup is performed by the
native MCP discovery implementation.

### 24/7 supervision

Run the compiled binary (not repeated `cargo run`) under a supervisor with a
stable working directory, restart-on-failure and the above secret environment.
SQLite and the artifact directory must be persistent local storage. Only
trusted users should be able to write the queue database or delivery tree.
The worker has full local CAD access, and prompts/drawing data are sent to the
configured API provider for reasoning and Vision.

On Windows, use Task Scheduler with **Run only when user is logged on**,
restart on failure, and a dedicated desktop account whose CAD rendering is
known to work. Configure secrets outside the task's command-line arguments.
On Linux, use a graphical **user** service associated with the desktop session
(or configure a supported virtual display). A system service without a
display is not equivalent. The daemon handles Ctrl-C and stops dispatching
new CAD work after the current blocking API/tool call settles. It cannot
cancel a mutation already committed by CAD.

Monitor job `status`, `stage`, heartbeat/updated timestamps and `events` in
SQLite or the `status` command. Protect disk space and implement artifact
retention outside the queue; PNG/measurement evidence is intentionally kept.
Failed/incomplete drawings are retained for diagnosis, not silently discarded.
The worker refuses to create more documents when 32 are already open.

## Workflow and trust boundaries

1. **PM / Architect Planner:** a strict `MasterArchitecturalPlan` JSON schema
   produces grid axes, floor heights, rectangular room topology, openings,
   wet stacks, furniture and stairs. Schema validation and the deterministic
   solver reject invalid plans before any design batch is sent. Planner
   corrections include the actual solver error, with a bounded budget.
2. **DEV / CAD Execution:** the solver compiles parameterized coordinates
   into dependency-aware batches. Creation handles flow through real batch
   result bindings; they are never guessed. A block/profile dependency group
   is never split across batch boundaries. Batches use `summary`; individual
   tool/intent callers can request `changed_entities`. Additional evolution
   or repair work uses actual OpenAI function calls and runtime tool schemas,
   command/record-schema discovery, projected reads and atomic updates.
3. **QA / Spatial Critic:** after each completed logical phase (possibly several bounded batches) it measures real
   handles through the kernel, checks finite bounds and furniture Insert
   bounding-box collisions, runs target-format/version audit, captures an
   actual framed PNG and submits it to the Vision model. Actual kernel samples
   accompany images. Future-phase features are not demanded prematurely.
   Neither a positive Vision response nor `audit.ok` alone can override a
   deterministic failure or lossy-conversion report. Negative technical audit
   reports remain available to the repair loop.
4. **Evolution:** paged projected records from the whole database, manifests
   and state are journaled. The model checks the original brief and identifies
   a missing phase or provides completion evidence. DEV implements missing
   work, QA repeats, and an iteration cap prevents endless embellishment.
5. **Delivery:** final QA must pass. `save_verified` refuses overwrite/lossy
   conversion, writes and reopens the requested format/version, and checks
   its semantic manifest/raw DXF handle graph. The worker independently hashes
   the actual output and compares the returned SHA-256 before completing.

Function calls are limited to the pinned drawing. The DEV agent cannot
open/new/save/export arbitrary files, execute scripts, change session/document
identities or dismiss arbitrary dialogs. Agent-generated system-variable
updates are limited to selected CAD drawing/display variables. Reads have
bounded page sizes; `records` uses RFC 6901 `paths`/`where`. The complete set
of 20 MCP tool names and the operation names have Rust enum wrappers, while
runtime schemas remain authoritative for operation-specific fields.

## Parametric solver constraints

Print the current authoritative strict schema and embedded planning rules:

```powershell
ocs-ai-worker schema
```

The deterministic model is **orthogonal and rectangular**, not an arbitrary
BIM/site-planning engine: 2–9 X/Y axes, 1–4 levels, room rectangles that tile
the structural footprint, aligned wet stacks, straight east/north stairs,
axis-aligned furniture and a flat roof. The schema descriptions specify exact
spacing, range, opening/pier, door-graph and clearance restrictions. Plans
outside the supported domain fail explicitly rather than being approximated.

Perimeter/interior walls use 200/100 mm centreline offsets. Shared wall
segments are deduplicated. Openings split wall geometry, with real window
sills and lintels in 3D. Structural columns occupy every grid intersection.
Door sweeps are conservatively checked as full width-squares, not optimistic
arc-only clearance, so some physically workable designs are rejected.
Furniture clearance envelopes must fit the room and avoid doors, columns,
other furniture and stairs. Wet rooms align across levels. Straight stairs
use 17/21/25 risers and `2h+b=600 mm`, with landings and actual upper-floor
voids. This is intentionally conservative and not a substitute for a code
checker. Layer initialization includes `A-GRID`, `A-COLS`, `A-WALL-EXTR`,
`A-WALL-INTR`, `A-DOOR`, `A-GLAZ`, `A-STAIR`, `A-FURN`, `A-SANR`,
`A-3D-SLAB`, `A-3D-WALL`, `A-3D-ROOF`, `A-DIMS`, `A-ANNO`.

2D floor plans are placed side-by-side in XY to remain readable in model
space; 3D components share model XY and actual floor Z. Building dimensions
in the current schema reference structural centre lines, not cadastral/setback
or finished-face coordinates. The compiler extrudes closed profiles with the actual `EXTRUDE` Mode Solid
command and uses actual `SUBTRACT` for door/window/stair openings. Source
profiles are explicitly removed only after their dependent recipe completes;
binding groups are kept intact. Roof and slab are actual kernel BREP solids,
not planar DXF `Solid` faces masquerading as 3D. Door lintels are 2200 mm,
window sills 900 mm; desk/cabinet clearances are at least 700 mm. The solver
chooses the door hinge nearest a room-side wall, with the plan breaking exact
ties. `spatial.rs` is authoritative for the construction recipe and limits.

## Artifacts and failure recovery

Every job has a unique directory. Successful delivery contains `drawing.dxf`
or `drawing.dwg`, `report.json`, plan/phase definitions for newly generated
designs, discovery schemas, paginated projected records, kernel measurements,
QA JSON/PNG evidence and evolution decisions. `report.json` contains the
actual SHA-256, verified-save report and `professional_review_required=true`.
A failed job has `failure.json` when its output directory could be created.
The SQLite event journal records a generated mutation `request_id`, pinned
session/document/revision and request **before dispatch**, and its outcome
after completion. Files already present in a job directory are not overwritten.

A batch is sequential, **not an all-or-nothing transaction**. A failure or
pipe timeout can follow committed earlier steps. The bridge retains the exact
mutation envelope and ID on its original connection, but does not reconnect
and blindly redraw. A disconnected job is never automatically requeued.
Read `operation`/the journal and inspect the retained drawing before deciding
what to do. Only a definite pre-dispatch validation/policy error is returned
to DEV for a corrected request; an ambiguous dispatched mutation stops work.

```powershell
# Marks expired running jobs INTERRUPTED, not queued; minimum timeout 60s.
ocs-ai-worker recover --lease-seconds 600
```

Heartbeats continue during long API calls. Lease ownership fences updates.
After a crash, reconcile the drawing and artifacts, choose a verified source,
and submit a **new** explicit job. This favors not corrupting/duplicating CAD
over claiming automatic exactly-once recovery across a lost editor process.

## Real tests (no mock transport or fabricated model output)

```powershell
cargo test -p ocs-ai-worker
$env:OCS_EXECUTABLE = (Resolve-Path target/debug/OpenCADStudio.exe).Path
$env:OCS_MCP_EXECUTABLE = $env:OCS_EXECUTABLE
# Optional when several editors exist:
# $env:OCS_SESSION_ID = 'an explicitly discovered editor session id'

cargo test -p ocs-ai-worker --test live mcp_batch_measure_render_audit_verified_save -- --ignored --exact --nocapture
cargo test -p ocs-ai-worker --test live multilevel_compiler_real_stair_void -- --ignored --exact --nocapture
cargo test -p ocs-ai-worker --test live openai_structured_output -- --ignored --exact --nocapture
cargo test -p ocs-ai-worker --test live openai_parametric_planner -- --ignored --exact --nocapture
cargo test -p ocs-ai-worker --test live openai_function_call_reads_real_cad -- --ignored --exact --nocapture
cargo test -p ocs-ai-worker --test live prompt_to_verified_cad_worker -- --ignored --exact --nocapture
```

Run live mutation tests **serially** against a dedicated editor, never with
several independent controllers on the same session. API tests consume tokens.
The end-to-end worker test preserves real artifacts under
`target/ai-worker-e2e/` even on failure. `OCS_AI_E2E_PROMPT` changes its brief.
Pure tests exercise actual solver geometry/compilation, queue ownership/crash
rules, protocol decoding, tool catalog consistency and policy validation;
they do not stand up mock CAD/OpenAI servers. Ignored live tests are not
reported as successful live verification unless explicitly executed.

The existing native plugin tests share a process-global diagnostic queue.
The parallel workspace run exposed a competing `drain_errors()` assertion;
the complete serial workspace run passed. This is why the full-workspace
command above uses `--test-threads=1`; no production error handling was weakened
or test assertion removed to mask that race.

## Reproducible four-storey CAD drawing example
`examples/four_storey.rs` generates and validates one concrete 10000 ├ù 15000 mm
**grid-centreline** architectural scheme: four 3570 mm storeys, 24 spaces,
65 real openings, 32 schematic furniture instances, aligned wet stacks and
three 21-riser stairs (170 mm rise, 260 mm going). The compiler generates real
3D solids; derived roof/elevation/section linework uses the same parameters.
The roof is flat and **not an accessible terrace**; railings, balconies,
drainage, structural calculations and statutory approval are not included.
```powershell
cargo run -p ocs-ai-worker --example four_storey -- target/four-storey-house
# Use a fresh dedicated editor and its explicitly discovered session ID.
$env:OCS_SESSION_ID = 'the dedicated editor session_id'
cargo run -p ocs-ai-worker --example execute_phases -- target/four-storey-house
```
The generator does not contact CAD or OpenAI. It writes an actual validated
plan, executable CAD batches and eleven view regions, not fabricated server
responses. The execution example uses the real Rust MCP bridge, refuses an
existing `actual/` output directory instead of silently replaying work,
checks the compiled prefix against the validated plan, journals each batch,
measures actual BREP volumes, captures the native viewport, audits and saves
verified DWG and DXF with independent file hashing. The native editor is left
open with the generated drawing for inspection. Coordinate lengths remain
millimetres; the 150 mm slab projection around grid centrelines must not be
confused with the nominal 10 ├ù 15 m grid footprint.
