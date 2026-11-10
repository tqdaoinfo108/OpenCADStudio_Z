//! Deterministic millimetre-scale, orthogonal grid architecture, not arbitrary geometry.
//! Rooms tile one rectangular footprint on every level; their grid rectangles are wall
//! centre lines. Exterior/interior walls are 200/100 mm. Columns occupy every grid
//! intersection. Only axis-aligned furniture, inward single-leaf doors, rectangular
//! windows, straight east/north stairs and a flat slab roof are supported. Stair
//! flights have 17/21/25 risers and two 1000 mm landings; upper slabs have real voids.
//! Level plans are laid out side-by-side in XY; solids share the original XY and Z.
//! The caller must use a fresh, millimetre drawing and execute each phase as ONE
//! protocol-1 ocs_execute batch: bindings are phase-local, zero-based result indices.
//! Do not split/reorder steps without rebasing bindings. The caller owns envelopes,
//! idempotency, capability preflight, execution error handling and visual verification.

use anyhow::{bail, ensure, Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const EPS: f64 = 1e-6;
const MAX_STEPS: usize = 64;
const LANDING: f64 = 1000.0;

pub const AIA_LAYERS: &[&str] = &[
    "A-GRID",
    "A-COLS",
    "A-WALL-EXTR",
    "A-WALL-INTR",
    "A-DOOR",
    "A-GLAZ",
    "A-STAIR",
    "A-FURN",
    "A-SANR",
    "A-3D-SLAB",
    "A-3D-WALL",
    "A-3D-ROOF",
    "A-DIMS",
    "A-ANNO",
];

/// Planner contract, also attached to the strict schema's root description.
pub fn planning_constraints() -> &'static str {
    r#"Units: millimetres. Restricted orthogonal rectangular grid model, NOT arbitrary geometry.
All fields are required, wet_stack may be null; arrays may be empty except grid/levels/rooms.
name/id/labels: 1..80 printable characters, room ids and level names case-insensitively unique.
Grid x/y: 2..9 increasing axes, first=0, each bay 1500..12000, extent<=96000.
Levels: 1..4, ground elevation=0, each height=2700..4800; each next elevation=previous elevation+height.
Slab/flat roof thickness=100..400; column_size=200..600. No sloped roofs or arbitrary polygons.
Rooms: <=128, zero-based level and GridRect indices x0<x1,y0<y1 inside axis arrays.
Every level must be tiled completely by nonoverlapping room rectangles (wall centre lines).
Walls auto-generated: exterior=200, shared interior=100; columns at ALL grid intersections.
Wet rooms need wet_stack; same named stack occurs EXACTLY once on EVERY level with IDENTICAL rect.
Dry/stair rooms require wet_stack=null. Plumbing furniture (toilet/sink) only in wet rooms.
Openings <=128: room id, side=south/east/north/west. offset measured from low X/Y end of room side.
Opening width=600..3000, height=300..3000, sill=0..2000; top<=height-slab_thickness-200 (lintel).
Each opening fits ONE existing wall bay, and each jamb is >=column_size/2+100 from grid nodes.
Two openings on one bay need >=100 pier. Do not duplicate a shared door from both rooms.
Doors: sill=0,height=2200,width<=1200, swing INTO room. The solver puts the hinge nearest a room-side
wall; hinge_end only breaks exactly centred ties (low=false/high=true). Conservative square collision checks apply.
Windows: EXTERIOR walls only, sill=900,hinge_end=false. Doors must connect every room to a ground
exterior entrance or an upper arrival stair through a door graph. Upper exterior doors do not provide access.
Door swing's conservative full width-square must avoid columns, all other walls, other swings,
all furniture clearances and ALL stair footprints/landings. This deliberately rejects some safe arcs.
Furniture <=128: absolute model XY lower-left, axis aligned. width/depth<=3000,clearance=600..1500
on ALL sides; desk/cabinet clearance MUST be >=700. Expanded boxes fit room inset100 and avoid columns/each other/doors/stairs.
Minimum width/depth: bed900/1900,desk900/600,sofa1400/800,table800/800,toilet400/700,sink500/450,cabinet400/400.
Stairs <=8: lower_room/upper_room must be kind=stair, IDENTICAL rect, consecutive levels.
Each adjacent level pair MUST have a stair. Each stair room must be used by a stair.
Only straight east(+X) or north(+Y), width1000..2000, risers17/21/25. h=floor_height/risers in150..200,
b=600-2h in200..300, flight run=(risers-1)*b, plus two1000 landings. x/y is total footprint lower-left.
Whole stair fits room inset100 and avoids columns. Stairs on common levels cannot overlap, even stacked.
Upper slab flight holes are real voids; flat upper landing remains. No curved/dogleg stair or railings.
Compilation uses actual EXTRUDE Mode Solid profiles and SUBTRACT solids for door/window/stair voids.
Five logical phases are partitioned into MCP batches <=64 steps, with intact and rebased bindings;
unrequested empty phases are omitted. No structural/fire/accessibility certification.
Minimal valid plan (one room; change dimensions/features only while preserving constraints):
{"name":"Studio","grid":{"x":[0,6000],"y":[0,6000]},"levels":[{"name":"Ground","elevation":0,"height":3000}],"rooms":[{"id":"studio","name":"Studio","level":0,"rect":{"x0":0,"y0":0,"x1":1,"y1":1},"kind":"dry","wet_stack":null}],"openings":[{"room":"studio","side":"south","kind":"door","offset":1000,"width":900,"sill":0,"height":2200,"hinge_end":false}],"furniture":[{"room":"studio","kind":"desk","x":3000,"y":3000,"width":1000,"depth":600,"clearance":700}],"stairs":[],"slab_thickness":200,"roof_thickness":200,"column_size":300}
"#
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MasterArchitecturalPlan {
    pub name: String,
    pub grid: StructuralGrid,
    pub levels: Vec<Level>,
    pub rooms: Vec<Room>,
    pub openings: Vec<Opening>,
    pub furniture: Vec<Furniture>,
    pub stairs: Vec<Stair>,
    pub slab_thickness: f64,
    pub roof_thickness: f64,
    pub column_size: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StructuralGrid {
    /// Strictly increasing millimetres, starting at zero, 2..=9 axes, 1500..=12000 per bay.
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Level {
    pub name: String,
    pub elevation: f64,
    /// Floor-to-floor height; the top level's height locates the flat roof.
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GridRect {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RoomKind {
    Dry,
    Wet,
    Stair,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub level: usize,
    pub rect: GridRect,
    pub kind: RoomKind,
    /// Required nullable field. Wet rooms sharing this identifier must have exactly
    /// the same grid rectangle and occur on every level; dry/stair rooms use null.
    #[serde(deserialize_with = "required_nullable_string")]
    pub wet_stack: Option<String>,
}

fn required_nullable_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    South,
    East,
    North,
    West,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpeningKind {
    Door,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Opening {
    pub room: String,
    pub side: Side,
    pub kind: OpeningKind,
    /// From the low X/Y end of the room side, not from the clear inner corner.
    pub offset: f64,
    pub width: f64,
    pub sill: f64,
    pub height: f64,
    /// Tie-break hint for a centred door: high end if true. Otherwise the solver
    /// chooses the nearest side wall. Windows require false.
    pub hinge_end: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FurnitureKind {
    Bed,
    Desk,
    Sofa,
    Table,
    Toilet,
    Sink,
    Cabinet,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Furniture {
    pub room: String,
    pub kind: FurnitureKind,
    /// Absolute model XY, lower-left corner; axis-aligned only.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub depth: f64,
    /// Conservatively reserved on all four sides, at least 600 mm.
    pub clearance: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StairDirection {
    East,
    North,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Stair {
    pub lower_room: String,
    pub upper_room: String,
    /// Lower-left corner of the complete stair INCLUDING bottom/top landings.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub risers: u8,
    pub direction: StairDirection,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Phase {
    pub name: String,
    pub steps: Vec<Value>,
}

/// JSON Schema for strict structured output, not the full semantic validator.
/// Every property (including nullable options) is required, and every object is
/// closed. Geometric and cross-reference constraints are enforced by validate.
pub fn plan_schema() -> Value {
    fn strict(value: &mut Value) {
        match value {
            Value::Object(obj) => {
                obj.remove("$schema");
                obj.remove("default");
                obj.remove("format");
                if obj.get("type").and_then(Value::as_str) == Some("object") {
                    obj.insert("additionalProperties".into(), json!(false));
                    if let Some(properties) = obj.get("properties").and_then(Value::as_object) {
                        let keys: Vec<_> = properties.keys().cloned().collect();
                        obj.insert("required".into(), json!(keys));
                    }
                }
                for child in obj.values_mut() {
                    strict(child);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(strict),
            _ => {}
        }
    }
    let mut schema = serde_json::to_value(schemars::schema_for!(MasterArchitecturalPlan))
        .expect("derived JSON Schema is serializable");
    schema["description"] = json!(planning_constraints());
    strict(&mut schema);
    schema
}

#[derive(Debug, Clone, Copy)]
struct Rect {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

impl Rect {
    fn expanded(self, d: f64) -> Self {
        Self {
            x0: self.x0 - d,
            y0: self.y0 - d,
            x1: self.x1 + d,
            y1: self.y1 + d,
        }
    }
    fn overlaps(self, b: Self) -> bool {
        self.x0 < b.x1 - EPS && self.x1 > b.x0 + EPS && self.y0 < b.y1 - EPS && self.y1 > b.y0 + EPS
    }
    fn contains(self, b: Self) -> bool {
        b.x0 >= self.x0 - EPS
            && b.y0 >= self.y0 - EPS
            && b.x1 <= self.x1 + EPS
            && b.y1 <= self.y1 + EPS
    }
    fn shifted(self, dx: f64) -> Self {
        Self {
            x0: self.x0 + dx,
            x1: self.x1 + dx,
            ..self
        }
    }
    fn vertices(self) -> Value {
        json!([
            [self.x0, self.y0],
            [self.x1, self.y0],
            [self.x1, self.y1],
            [self.x0, self.y1]
        ])
    }
}

// axis 0: horizontal, axis 1: vertical; line/span are grid indices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct WallKey {
    level: usize,
    axis: u8,
    line: usize,
    span: usize,
}

#[derive(Debug, Clone)]
struct Wall {
    key: WallKey,
    start: f64,
    end: f64,
    coordinate: f64,
    thickness: f64,
}

impl Wall {
    fn layer(&self) -> &'static str {
        if self.thickness == 200.0 {
            "A-WALL-EXTR"
        } else {
            "A-WALL-INTR"
        }
    }
    fn rect(&self, start: f64, end: f64) -> Rect {
        let h = self.thickness / 2.0;
        if self.key.axis == 0 {
            Rect {
                x0: start,
                y0: self.coordinate - h,
                x1: end,
                y1: self.coordinate + h,
            }
        } else {
            Rect {
                x0: self.coordinate - h,
                y0: start,
                x1: self.coordinate + h,
                y1: end,
            }
        }
    }
}

struct SolvedOpening {
    room: usize,
    wall: usize,
    start: f64,
    end: f64,
    hinge: [f64; 2],
    closed: [f64; 2],
    inward: [f64; 2],
    swing: Option<Rect>,
}

struct SolvedStair {
    lower: usize,
    upper: usize,
    footprint: Rect,
    flight: Rect,
    rise: f64,
    going: f64,
}

struct Solution {
    walls: Vec<Wall>,
    openings: Vec<SolvedOpening>,
    stairs: Vec<SolvedStair>,
}

fn bounded(value: f64, min: f64, max: f64, name: &str) -> Result<()> {
    ensure!(
        value.is_finite() && value >= min && value <= max,
        "{name} must be finite and in [{min}, {max}] mm"
    );
    Ok(())
}

fn label(value: &str, name: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty()
            && value.chars().count() <= 80
            && !value.chars().any(char::is_control),
        "{name} must be 1..80 printable characters"
    );
    Ok(())
}

fn room_rect(plan: &MasterArchitecturalPlan, room: &Room) -> Rect {
    Rect {
        x0: plan.grid.x[room.rect.x0],
        x1: plan.grid.x[room.rect.x1],
        y0: plan.grid.y[room.rect.y0],
        y1: plan.grid.y[room.rect.y1],
    }
}

fn furniture_rect(f: &Furniture) -> Rect {
    Rect {
        x0: f.x,
        y0: f.y,
        x1: f.x + f.width,
        y1: f.y + f.depth,
    }
}

fn columns(plan: &MasterArchitecturalPlan) -> Vec<Rect> {
    plan.grid
        .x
        .iter()
        .flat_map(|&x| {
            plan.grid.y.iter().map(move |&y| {
                let h = plan.column_size / 2.0;
                Rect {
                    x0: x - h,
                    y0: y - h,
                    x1: x + h,
                    y1: y + h,
                }
            })
        })
        .collect()
}

fn room_index(plan: &MasterArchitecturalPlan, id: &str) -> Result<usize> {
    plan.rooms
        .iter()
        .position(|r| r.id == id)
        .with_context(|| format!("unknown room '{id}'"))
}

fn topology(plan: &MasterArchitecturalPlan) -> Result<Vec<Wall>> {
    let nx = plan.grid.x.len() - 1;
    let ny = plan.grid.y.len() - 1;
    let mut walls = Vec::new();
    for level in 0..plan.levels.len() {
        let mut cells = vec![None; nx * ny];
        for (i, room) in plan
            .rooms
            .iter()
            .enumerate()
            .filter(|(_, r)| r.level == level)
        {
            for y in room.rect.y0..room.rect.y1 {
                for x in room.rect.x0..room.rect.x1 {
                    ensure!(
                        cells[y * nx + x].replace(i).is_none(),
                        "overlapping room polygons on level {level} at grid cell {x},{y}"
                    );
                }
            }
        }
        ensure!(
            cells.iter().all(Option::is_some),
            "rooms must completely tile the rectangular footprint on level {level}"
        );
        for axis in 0..=1 {
            let (along, across) = if axis == 0 {
                (&plan.grid.x, &plan.grid.y)
            } else {
                (&plan.grid.y, &plan.grid.x)
            };
            for line in 0..across.len() {
                for span in 0..along.len() - 1 {
                    let cell = |side: usize| -> Option<usize> {
                        if axis == 0 {
                            cells[side * nx + span]
                        } else {
                            cells[span * nx + side]
                        }
                    };
                    let before = if line > 0 { cell(line - 1) } else { None };
                    let after = if line + 1 < across.len() {
                        cell(line)
                    } else {
                        None
                    };
                    if before != after {
                        walls.push(Wall {
                            key: WallKey {
                                level,
                                axis,
                                line,
                                span,
                            },
                            start: along[span],
                            end: along[span + 1],
                            coordinate: across[line],
                            thickness: if before.is_none() || after.is_none() {
                                200.0
                            } else {
                                100.0
                            },
                        });
                    }
                }
            }
        }
    }
    Ok(walls)
}

fn solve_opening(
    plan: &MasterArchitecturalPlan,
    walls: &[Wall],
    o: &Opening,
) -> Result<SolvedOpening> {
    let ri = room_index(plan, &o.room)?;
    let room = &plan.rooms[ri];
    let r = room_rect(plan, room);
    bounded(o.offset, 0.0, 96000.0, "opening offset")?;
    bounded(o.width, 600.0, 3000.0, "opening width")?;
    bounded(o.height, 300.0, 3000.0, "opening height")?;
    bounded(o.sill, 0.0, 2000.0, "opening sill")?;
    let clear_height = plan.levels[room.level].height - plan.slab_thickness;
    ensure!(
        o.sill + o.height <= clear_height - 200.0 + EPS,
        "opening needs a 200 mm lintel"
    );
    match o.kind {
        OpeningKind::Door => {
            ensure!(
                o.sill == 0.0 && o.height == 2200.0 && o.width <= 1200.0,
                "doors require zero sill, height=2200 and width <=1200 mm"
            );
        }
        OpeningKind::Window => ensure!(
            o.sill == 900.0 && !o.hinge_end,
            "windows require sill=900 mm and hinge_end=false"
        ),
    }
    let (axis, line, base, inward) = match o.side {
        Side::South => (0, room.rect.y0, r.x0, [0.0, 1.0]),
        Side::North => (0, room.rect.y1, r.x0, [0.0, -1.0]),
        Side::West => (1, room.rect.x0, r.y0, [1.0, 0.0]),
        Side::East => (1, room.rect.x1, r.y0, [-1.0, 0.0]),
    };
    let start = base + o.offset;
    let end = start + o.width;
    let margin = plan.column_size / 2.0 + 100.0;
    let wi = walls
        .iter()
        .position(|w| {
            w.key.level == room.level
                && w.key.axis == axis
                && w.key.line == line
                && start >= w.start + margin - EPS
                && end <= w.end - margin + EPS
        })
        .context(
            "opening must fit one existing grid wall bay, clear of columns/junctions by 100 mm",
        )?;
    let w = &walls[wi];
    ensure!(
        end <= if axis == 0 { r.x1 } else { r.y1 },
        "opening outside room side"
    );
    ensure!(
        o.kind != OpeningKind::Window || w.thickness == 200.0,
        "only exterior windows are supported"
    );
    let high = if axis == 0 { r.x1 } else { r.y1 };
    let low_gap = start - base;
    let high_gap = high - end;
    let hinge_end = high_gap < low_gap - EPS || ((high_gap - low_gap).abs() <= EPS && o.hinge_end);
    let hinge_axis = if hinge_end { end } else { start };
    let hinge = if axis == 0 {
        [hinge_axis, w.coordinate + inward[1] * w.thickness / 2.0]
    } else {
        [w.coordinate + inward[0] * w.thickness / 2.0, hinge_axis]
    };
    let sign = if hinge_end { -1.0 } else { 1.0 };
    let closed = if axis == 0 { [sign, 0.0] } else { [0.0, sign] };
    let a = [
        hinge[0] + closed[0] * o.width,
        hinge[1] + closed[1] * o.width,
    ];
    let b = [
        hinge[0] + inward[0] * o.width,
        hinge[1] + inward[1] * o.width,
    ];
    let swing = (o.kind == OpeningKind::Door).then_some(Rect {
        x0: hinge[0].min(a[0]).min(b[0]),
        y0: hinge[1].min(a[1]).min(b[1]),
        x1: hinge[0].max(a[0]).max(b[0]),
        y1: hinge[1].max(a[1]).max(b[1]),
    });
    if let Some(swing) = swing {
        ensure!(
            r.expanded(-w.thickness / 2.0).contains(swing),
            "door swing escapes its room"
        );
    }
    Ok(SolvedOpening {
        room: ri,
        wall: wi,
        start,
        end,
        hinge,
        closed,
        inward,
        swing,
    })
}

fn solve_stair(plan: &MasterArchitecturalPlan, s: &Stair) -> Result<SolvedStair> {
    let lower = room_index(plan, &s.lower_room)?;
    let upper = room_index(plan, &s.upper_room)?;
    let lo = &plan.rooms[lower];
    let hi = &plan.rooms[upper];
    ensure!(
        lo.kind == RoomKind::Stair
            && hi.kind == RoomKind::Stair
            && hi.level == lo.level + 1
            && lo.rect == hi.rect,
        "stairs require identical stair-room rectangles on consecutive levels"
    );
    ensure!(
        matches!(s.risers, 17 | 21 | 25),
        "stairs require 17, 21 or 25 risers"
    );
    bounded(s.x, 0.0, 96000.0, "stair x")?;
    bounded(s.y, 0.0, 96000.0, "stair y")?;
    bounded(s.width, 1000.0, 2000.0, "stair width")?;
    let rise =
        (plan.levels[hi.level].elevation - plan.levels[lo.level].elevation) / f64::from(s.risers);
    let going = 600.0 - 2.0 * rise;
    bounded(rise, 150.0, 200.0, "stair riser height")?;
    bounded(going, 200.0, 300.0, "stair going (2h+b=600)")?;
    let run = f64::from(s.risers - 1) * going;
    let (footprint, flight) = match s.direction {
        StairDirection::East => (
            Rect {
                x0: s.x,
                y0: s.y,
                x1: s.x + run + 2.0 * LANDING,
                y1: s.y + s.width,
            },
            Rect {
                x0: s.x + LANDING,
                y0: s.y,
                x1: s.x + LANDING + run,
                y1: s.y + s.width,
            },
        ),
        StairDirection::North => (
            Rect {
                x0: s.x,
                y0: s.y,
                x1: s.x + s.width,
                y1: s.y + run + 2.0 * LANDING,
            },
            Rect {
                x0: s.x,
                y0: s.y + LANDING,
                x1: s.x + s.width,
                y1: s.y + LANDING + run,
            },
        ),
    };
    ensure!(
        room_rect(plan, lo).expanded(-100.0).contains(footprint),
        "stair flight and both 1000 mm landings must fit the clear stair room"
    );
    ensure!(
        columns(plan).iter().all(|c| !c.overlaps(footprint)),
        "stair intersects a structural column"
    );
    Ok(SolvedStair {
        lower,
        upper,
        footprint,
        flight,
        rise,
        going,
    })
}

fn solve(plan: &MasterArchitecturalPlan) -> Result<Solution> {
    label(&plan.name, "plan name")?;
    for (name, axis) in [("x", &plan.grid.x), ("y", &plan.grid.y)] {
        ensure!(
            (2..=9).contains(&axis.len()),
            "grid {name} requires 2..9 axes"
        );
        ensure!(axis[0] == 0.0, "grid {name} must start at zero");
        for &v in axis {
            bounded(v, 0.0, 96000.0, "grid coordinate")?;
        }
        for pair in axis.windows(2) {
            bounded(pair[1] - pair[0], 1500.0, 12000.0, "grid bay")?;
        }
    }
    bounded(plan.slab_thickness, 100.0, 400.0, "slab thickness")?;
    bounded(plan.roof_thickness, 100.0, 400.0, "flat roof thickness")?;
    bounded(plan.column_size, 200.0, 600.0, "column size")?;
    ensure!((1..=4).contains(&plan.levels.len()), "requires 1..4 levels");
    ensure!(
        plan.levels[0].elevation == 0.0,
        "ground floor elevation must be zero"
    );
    let mut names = BTreeSet::new();
    for (i, level) in plan.levels.iter().enumerate() {
        label(&level.name, "level name")?;
        ensure!(
            names.insert(level.name.to_lowercase()),
            "duplicate level name"
        );
        bounded(level.elevation, 0.0, 18000.0, "level elevation")?;
        bounded(level.height, 2700.0, 4800.0, "floor-to-floor height")?;
        if i > 0 {
            let prev = &plan.levels[i - 1];
            ensure!(
                (level.elevation - prev.elevation - prev.height).abs() <= EPS,
                "levels must be contiguous in elevation"
            );
        }
    }
    ensure!(
        !plan.rooms.is_empty() && plan.rooms.len() <= 128,
        "requires 1..128 rooms"
    );
    ensure!(
        plan.openings.len() <= 128 && plan.furniture.len() <= 128 && plan.stairs.len() <= 8,
        "component count exceeds bounds (128 openings/furniture, 8 stairs)"
    );
    let mut ids = BTreeSet::new();
    let mut stacks: BTreeMap<&str, Vec<&Room>> = BTreeMap::new();
    for r in &plan.rooms {
        label(&r.id, "room id")?;
        label(&r.name, "room name")?;
        ensure!(
            ids.insert(r.id.to_lowercase()),
            "duplicate case-insensitive room id"
        );
        ensure!(
            r.level < plan.levels.len(),
            "room references nonexistent level"
        );
        let g = r.rect;
        ensure!(
            g.x0 < g.x1 && g.y0 < g.y1 && g.x1 < plan.grid.x.len() && g.y1 < plan.grid.y.len(),
            "invalid room grid rectangle"
        );
        match (&r.kind, &r.wet_stack) {
            (RoomKind::Wet, Some(stack)) => {
                label(stack, "wet stack")?;
                stacks.entry(stack).or_default().push(r);
            }
            (RoomKind::Wet, None) => bail!("wet room requires wet_stack"),
            (_, Some(_)) => bail!("only wet rooms may specify wet_stack"),
            _ => {}
        }
    }
    for (name, rooms) in stacks {
        let floors: BTreeSet<_> = rooms.iter().map(|r| r.level).collect();
        ensure!(
            rooms.len() == plan.levels.len()
                && floors.len() == plan.levels.len()
                && rooms.iter().all(|r| r.rect == rooms[0].rect),
            "wet stack '{name}' must align exactly and occur once on every level"
        );
    }
    let walls = topology(plan)?;
    let openings = plan
        .openings
        .iter()
        .map(|o| solve_opening(plan, &walls, o))
        .collect::<Result<Vec<_>>>()?;
    for (i, a) in openings.iter().enumerate() {
        for b in &openings[..i] {
            ensure!(
                a.wall != b.wall
                    || a.start >= b.end + 100.0 - EPS
                    || b.start >= a.end + 100.0 - EPS,
                "duplicate/overlapping openings or less than 100 mm pier on shared wall"
            );
            if plan.rooms[a.room].level == plan.rooms[b.room].level {
                if let (Some(aa), Some(bb)) = (a.swing, b.swing) {
                    ensure!(!aa.overlaps(bb), "door swing envelopes collide");
                }
            }
        }
        if let Some(swing) = a.swing {
            ensure!(
                columns(plan).iter().all(|c| !c.overlaps(swing)),
                "door swing intersects column"
            );
            for (wi, w) in walls
                .iter()
                .enumerate()
                .filter(|(_, w)| w.key.level == plan.rooms[a.room].level)
            {
                if wi != a.wall {
                    ensure!(
                        !w.rect(w.start, w.end).overlaps(swing),
                        "door swing intersects wall"
                    );
                }
            }
        }
    }
    let stairs = plan
        .stairs
        .iter()
        .map(|s| solve_stair(plan, s))
        .collect::<Result<Vec<_>>>()?;
    for (i, a) in stairs.iter().enumerate() {
        let al = plan.rooms[a.lower].level;
        for b in &stairs[..i] {
            let bl = plan.rooms[b.lower].level;
            ensure!(
                al.abs_diff(bl) > 1 || !a.footprint.overlaps(b.footprint),
                "stair volumes/landings overlap; stacked straight flights are unsupported"
            );
        }
        for o in &openings {
            let level = plan.rooms[o.room].level;
            if level == al || level == al + 1 {
                if let Some(swing) = o.swing {
                    ensure!(
                        !a.footprint.overlaps(swing),
                        "door swing intersects stairs/landing"
                    );
                }
            }
        }
    }
    for level in 0..plan.levels.len() - 1 {
        ensure!(
            stairs.iter().any(|s| plan.rooms[s.lower].level == level),
            "each adjacent level pair requires a stair"
        );
    }
    for (ri, r) in plan
        .rooms
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == RoomKind::Stair)
    {
        ensure!(
            stairs.iter().any(|s| s.lower == ri || s.upper == ri),
            "stair room '{}' has no staircase",
            r.id
        );
    }
    let cols = columns(plan);
    for (i, f) in plan.furniture.iter().enumerate() {
        let ri = room_index(plan, &f.room)?;
        let room = &plan.rooms[ri];
        bounded(f.x, 0.0, 96000.0, "furniture x")?;
        bounded(f.y, 0.0, 96000.0, "furniture y")?;
        bounded(
            f.clearance,
            if matches!(f.kind, FurnitureKind::Desk | FurnitureKind::Cabinet) {
                700.0
            } else {
                600.0
            },
            1500.0,
            "furniture clearance",
        )?;
        let (min_w, min_d) = match f.kind {
            FurnitureKind::Bed => (900.0, 1900.0),
            FurnitureKind::Desk => (900.0, 600.0),
            FurnitureKind::Sofa => (1400.0, 800.0),
            FurnitureKind::Table => (800.0, 800.0),
            FurnitureKind::Toilet => (400.0, 700.0),
            FurnitureKind::Sink => (500.0, 450.0),
            FurnitureKind::Cabinet => (400.0, 400.0),
        };
        bounded(f.width, min_w, 3000.0, "furniture width")?;
        bounded(f.depth, min_d, 3000.0, "furniture depth")?;
        ensure!(
            !matches!(f.kind, FurnitureKind::Toilet | FurnitureKind::Sink)
                || room.kind == RoomKind::Wet,
            "plumbing fixtures require a vertically aligned wet room"
        );
        let physical = furniture_rect(f);
        let ergonomic = physical.expanded(f.clearance);
        ensure!(
            room_rect(plan, room).expanded(-100.0).contains(ergonomic),
            "furniture ergonomic envelope leaves clear room"
        );
        ensure!(
            cols.iter().all(|c| !c.overlaps(ergonomic)),
            "furniture clearance intersects column"
        );
        for g in &plan.furniture[..i] {
            let gr = &plan.rooms[room_index(plan, &g.room)?];
            if gr.level == room.level {
                ensure!(
                    !ergonomic.overlaps(furniture_rect(g).expanded(g.clearance)),
                    "furniture ergonomic envelopes collide"
                );
            }
        }
        for o in &openings {
            if plan.rooms[o.room].level == room.level {
                if let Some(swing) = o.swing {
                    ensure!(
                        !ergonomic.overlaps(swing),
                        "door swing intersects furniture clearance"
                    );
                }
            }
        }
        for s in &stairs {
            if room.level == plan.rooms[s.lower].level || room.level == plan.rooms[s.upper].level {
                ensure!(
                    !ergonomic.overlaps(s.footprint),
                    "furniture intersects stairs/landing"
                );
            }
        }
    }
    // A door graph is a topological reachability check, not a fire/egress certification.
    for level in 0..plan.levels.len() {
        let mut reachable = BTreeSet::new();
        let mut links = Vec::new();
        for (o, solved) in plan
            .openings
            .iter()
            .zip(&openings)
            .filter(|(o, s)| o.kind == OpeningKind::Door && plan.rooms[s.room].level == level)
        {
            let w = &walls[solved.wall];
            let mid = (solved.start + solved.end) / 2.0;
            let other = if w.key.axis == 0 {
                [mid, w.coordinate - solved.inward[1]]
            } else {
                [w.coordinate - solved.inward[0], mid]
            };
            let neighbor = plan
                .rooms
                .iter()
                .enumerate()
                .find(|(i, r)| {
                    *i != solved.room
                        && r.level == level
                        && room_rect(plan, r).contains(Rect {
                            x0: other[0],
                            y0: other[1],
                            x1: other[0],
                            y1: other[1],
                        })
                })
                .map(|(i, _)| i);
            if let Some(neighbor) = neighbor {
                links.push((solved.room, neighbor));
            } else if level == 0 {
                reachable.insert(solved.room);
            }
            let _ = o;
        }
        if level > 0 {
            for s in &stairs {
                if plan.rooms[s.upper].level == level {
                    reachable.insert(s.upper);
                }
            }
        }
        loop {
            let before = reachable.len();
            for &(a, b) in &links {
                if reachable.contains(&a) || reachable.contains(&b) {
                    reachable.insert(a);
                    reachable.insert(b);
                }
            }
            if before == reachable.len() {
                break;
            }
        }
        ensure!(plan.rooms.iter().enumerate().filter(|(_, r)| r.level == level).all(|(i, _)| reachable.contains(&i)),
            "every room must connect through doors to exterior (ground) or an arrival stair (upper levels)");
    }
    Ok(Solution {
        walls,
        openings,
        stairs,
    })
}

pub fn validate(plan: &MasterArchitecturalPlan) -> Result<()> {
    solve(plan).map(|_| ())
}

fn line(a: [f64; 2], b: [f64; 2], layer: &str) -> Value {
    json!({"type":"Line","layer":layer,"start":a,"end":b})
}

fn poly(r: Rect, layer: &str) -> Value {
    json!({"type":"LwPolyline","layer":layer,"vertices":r.vertices(),"closed":true})
}

fn text(value: &str, x: f64, y: f64, height: f64) -> Value {
    json!({"type":"Text","layer":"A-ANNO","value":value,"position":[x,y],"height":height})
}

fn room_label(plan: &MasterArchitecturalPlan, solved: &Solution, room: &Room, shift: f64) -> Value {
    let room_bounds = room_rect(plan, room);
    let target = [
        (room_bounds.x0 + room_bounds.x1) / 2.0,
        (room_bounds.y0 + room_bounds.y1) / 2.0,
    ];
    let mut best = None;
    for y in room.rect.y0..room.rect.y1 {
        for x in room.rect.x0..room.rect.x1 {
            let bay = Rect {
                x0: plan.grid.x[x],
                y0: plan.grid.y[y],
                x1: plan.grid.x[x + 1],
                y1: plan.grid.y[y + 1],
            }
            .expanded(-350.0);
            let width = (bay.x1 - bay.x0).min(2600.0);
            let cx = (bay.x0 + bay.x1) / 2.0;
            let cy = (bay.y0 + bay.y1) / 2.0;
            let mut height = 180.0;
            let chars = room.name.chars().count() as f64;
            let lines = |h: f64| ((chars * 0.8 * h / width).ceil()).max(1.0);
            while lines(height) * height * 1.7 > bay.y1 - bay.y0 && height > 60.0 {
                height -= 5.0;
            }
            let extent = Rect {
                x0: cx - width / 2.0,
                x1: cx + width / 2.0,
                y0: cy - lines(height) * height * 0.85,
                y1: cy + lines(height) * height * 0.85,
            };
            let blocked = plan
                .furniture
                .iter()
                .filter(|f| f.room == room.id)
                .any(|f| extent.overlaps(furniture_rect(f).expanded(f.clearance)))
                || solved
                    .openings
                    .iter()
                    .filter(|o| plan.rooms[o.room].level == room.level)
                    .any(|o| o.swing.is_some_and(|r| r.overlaps(extent)))
                || solved
                    .stairs
                    .iter()
                    .filter(|s| {
                        plan.rooms[s.lower].level == room.level
                            || plan.rooms[s.upper].level == room.level
                    })
                    .any(|s| s.footprint.overlaps(extent));
            let score = (cx - target[0]).powi(2)
                + (cy - target[1]).powi(2)
                + if blocked { 1e12 } else { 0.0 };
            if best
                .as_ref()
                .is_none_or(|(previous, _, _)| score < *previous)
            {
                best = Some((score, extent, height));
            }
        }
    }
    let (_, extent, height) = best.expect("validated room contains at least one grid bay");
    let value = room
        .name
        .replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}");
    json!({"type":"MText","layer":"A-ANNO","value":value,"position":[extent.x0+shift,extent.y1],
        "height":height,"width":extent.x1-extent.x0})
}
fn create(steps: &mut Vec<Value>, entities: Vec<Value>) {
    for chunk in entities.chunks(200) {
        steps.push(json!({"op":"entities_create","entities":chunk}));
    }
}

/// block_define moves sources into the definition and creates one genuine Insert.
/// insert_at avoids an extra reference at the origin; handles come from the engine.
fn block(
    steps: &mut Vec<Value>,
    name: &str,
    geometry: Vec<Value>,
    position: [f64; 2],
    layer: &str,
) {
    set_layer(steps, layer);
    let source = steps.len();
    steps.push(json!({"op":"entities_create","entities":geometry}));
    steps.push(
        json!({"op":"block_define","name":name,"base":[0,0],"insert_at":position,
        "bindings":{"handles":{"step":source,"path":"/result/handles"}}}),
    );
}

fn run(steps: &mut Vec<Value>, cmd: String) {
    steps.push(json!({"op":"run","cmd":cmd}));
}

fn set_layer(steps: &mut Vec<Value>, layer: &str) {
    steps.push(json!({"op":"sysvar","set":{"CLAYER":layer}}));
}

#[derive(Clone, Copy)]
struct Prism {
    rect: Rect,
    z0: f64,
    z1: f64,
}
struct SolidRecipe {
    layer: &'static str,
    prisms: Vec<Prism>,
    cutters: Vec<Prism>,
}
fn extrude(steps: &mut Vec<Value>, prisms: &[Prism], layer: &str, subtract_from: Option<&str>) {
    if prisms.is_empty() {
        return;
    }
    let p = prisms[0];
    set_layer(steps, layer);
    let source = steps.len();
    steps.push(json!({"op":"entities_create","entities":prisms.iter().map(|p|poly(p.rect,layer)).collect::<Vec<_>>()}));
    if p.z0 != 0.0 {
        steps.push(
            json!({"op":"entities_transform","action":"move","vector":[0,0,p.z0],
            "bindings":{"handles":{"step":source,"path":"/result/handles"}}}),
        );
    }
    steps.push(json!({"op":"select","clear":true}));
    steps.push(json!({"op":"start","cmd":"EXTRUDE"}));
    for token in ["Mode", "Solid"] {
        steps.push(json!({"op":"input","kind":"token","text":token}));
    }
    steps.push(json!({"op":"input","kind":"selection",
        "bindings":{"handles":{"step":source,"path":"/result/handles"}}}));
    steps.push(json!({"op":"input","kind":"enter"}));
    for token in ["Taper", "0"] {
        steps.push(json!({"op":"input","kind":"token","text":token}));
    }
    steps.push(json!({"op":"input","kind":"text","text":(p.z1-p.z0).to_string()}));
    if let Some(base_layer) = subtract_from {
        // Last is the actual selectable entity with highest allocated handle.
        // Exactly one cutter is extruded, and no geometry is created before Last.
        steps.push(json!({"op":"select","clear":true,"type":"3DSOLID","layer":base_layer}));
        steps.push(json!({"op":"start","cmd":"SUBTRACT"}));
        steps.push(json!({"op":"input","kind":"token","text":"Last"}));
        steps.push(json!({"op":"input","kind":"enter"}));
    }
    // DELOBJ=0: bound source profiles remain until this operation. This binding
    // also keeps the entire extrusion/Boolean recipe within one bounded batch.
    steps.push(json!({"op":"entities_delete","bindings":{"handles":{"step":source,"path":"/result/handles"}}}));
}
fn solid_recipes(plan: &MasterArchitecturalPlan, solved: &Solution) -> Vec<SolidRecipe> {
    let footprint = Rect {
        x0: 0.0,
        y0: 0.0,
        x1: *plan.grid.x.last().unwrap(),
        y1: *plan.grid.y.last().unwrap(),
    }
    .expanded(plan.column_size / 2.0);
    let mut slabs = SolidRecipe {
        layer: "A-3D-SLAB",
        prisms: Vec::new(),
        cutters: Vec::new(),
    };
    let mut walls = SolidRecipe {
        layer: "A-3D-WALL",
        prisms: Vec::new(),
        cutters: Vec::new(),
    };
    for l in &plan.levels {
        slabs.prisms.push(Prism {
            rect: footprint,
            z0: l.elevation - plan.slab_thickness,
            z1: l.elevation,
        });
        walls
            .prisms
            .extend(columns(plan).into_iter().map(|rect| Prism {
                rect,
                z0: l.elevation,
                z1: l.elevation + l.height - plan.slab_thickness,
            }));
    }
    for w in &solved.walls {
        let l = &plan.levels[w.key.level];
        walls.prisms.push(Prism {
            rect: w.rect(w.start, w.end),
            z0: l.elevation,
            z1: l.elevation + l.height - plan.slab_thickness,
        });
    }
    for (o, s) in plan.openings.iter().zip(&solved.openings) {
        let w = &solved.walls[s.wall];
        let elevation = plan.levels[w.key.level].elevation;
        let mut rect = w.rect(s.start, s.end);
        if w.key.axis == 0 {
            rect.y0 -= 10.0;
            rect.y1 += 10.0;
        } else {
            rect.x0 -= 10.0;
            rect.x1 += 10.0;
        }
        walls.cutters.push(Prism {
            rect,
            z0: elevation + o.sill
                - if o.kind == OpeningKind::Door {
                    1.0
                } else {
                    0.0
                },
            z1: elevation + o.sill + o.height,
        });
    }
    for (s, g) in plan.stairs.iter().zip(&solved.stairs) {
        let z = plan.levels[plan.rooms[g.lower].level].elevation;
        let upper_z = plan.levels[plan.rooms[g.upper].level].elevation;
        slabs.cutters.push(Prism {
            rect: g.flight,
            z0: upper_z - plan.slab_thickness - 1.0,
            z1: upper_z + 1.0,
        });
        for n in 0..s.risers - 1 {
            let a = f64::from(n) * g.going;
            let b = f64::from(n + 1) * g.going;
            let rect = match s.direction {
                StairDirection::East => Rect {
                    x0: g.flight.x0 + a,
                    x1: g.flight.x0 + b,
                    ..g.flight
                },
                StairDirection::North => Rect {
                    y0: g.flight.y0 + a,
                    y1: g.flight.y0 + b,
                    ..g.flight
                },
            };
            walls.prisms.push(Prism {
                rect,
                z0: z,
                z1: z + f64::from(n + 1) * g.rise,
            });
        }
    }
    let top = plan.levels.last().unwrap();
    let z = top.elevation + top.height - plan.slab_thickness;
    let roof = SolidRecipe {
        layer: "A-3D-ROOF",
        prisms: vec![Prism {
            rect: footprint,
            z0: z,
            z1: z + plan.roof_thickness,
        }],
        cutters: Vec::new(),
    };
    vec![slabs, walls, roof]
}
fn subtract_prism(base: Prism, hole: Prism) -> Vec<Prism> {
    if !base.rect.overlaps(hole.rect) || hole.z0 >= base.z1 - EPS || hole.z1 <= base.z0 + EPS {
        return vec![base];
    }
    let lo = base.z0.max(hole.z0);
    let hi = base.z1.min(hole.z1);
    let mut parts: Vec<_> = subtract_rect(base.rect, hole.rect)
        .into_iter()
        .map(|rect| Prism {
            rect,
            z0: lo,
            z1: hi,
        })
        .collect();
    if lo > base.z0 + EPS {
        parts.push(Prism { z1: lo, ..base });
    }
    if hi < base.z1 - EPS {
        parts.push(Prism { z0: hi, ..base });
    }
    parts
}
fn recipe_pieces(recipe: &SolidRecipe) -> Vec<Prism> {
    let mut pieces = recipe.prisms.clone();
    for hole in &recipe.cutters {
        pieces = pieces
            .into_iter()
            .flat_map(|base| subtract_prism(base, *hole))
            .collect();
    }
    pieces
}
fn subtract_rect(base: Rect, hole: Rect) -> Vec<Rect> {
    if !base.overlaps(hole) {
        return vec![base];
    }
    let x0 = base.x0.max(hole.x0);
    let y0 = base.y0.max(hole.y0);
    let x1 = base.x1.min(hole.x1);
    let y1 = base.y1.min(hole.y1);
    [
        Rect { x1: x0, ..base },
        Rect { x0: x1, ..base },
        Rect {
            x0,
            x1,
            y1: y0,
            ..base
        },
        Rect {
            x0,
            x1,
            y0: y1,
            ..base
        },
    ]
    .into_iter()
    .filter(|r| r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS)
    .collect()
}

fn wall_segments(wi: usize, solution: &Solution) -> Vec<&SolvedOpening> {
    let mut openings: Vec<_> = solution.openings.iter().filter(|o| o.wall == wi).collect();
    openings.sort_by(|a, b| a.start.total_cmp(&b.start));
    openings
}

fn grid_letter(mut index: usize) -> String {
    let mut letters = Vec::new();
    loop {
        letters.push(char::from(b'A' + (index % 26) as u8));
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    letters.into_iter().rev().collect()
}
/// Compile five logical phases into bounded, dependency-preserving batches. Reject unsupported
/// geometry, omitting components, or exceeding the MCP batch's 64-step maximum.
pub fn compile(plan: &MasterArchitecturalPlan) -> Result<Vec<Phase>> {
    let solved = solve(plan)?;
    let mut phases: Vec<_> = [
        "1 grid and columns",
        "2 walls openings and stairs 2D",
        "3 furniture blocks",
        "4 genuine 3D solids",
        "5 dimensions and annotations",
    ]
    .into_iter()
    .map(|name| Phase {
        name: name.into(),
        steps: Vec::new(),
    })
    .collect();
    let pitch = plan.grid.x.last().copied().unwrap() + 4000.0;
    let dx = |level: usize| (level as f64 + 1.0) * pitch;
    let ymax = *plan.grid.y.last().unwrap();
    let xmax = *plan.grid.x.last().unwrap();
    let mut grid = Vec::new();
    for level in 0..plan.levels.len() {
        for (i, x) in plan.grid.x.iter().enumerate() {
            grid.push(line(
                [x + dx(level), -800.0],
                [x + dx(level), ymax + 800.0],
                "A-GRID",
            ));
            grid.push(text(
                &(i + 1).to_string(),
                x + dx(level) - 75.0,
                -1100.0,
                150.0,
            ));
        }
        for (i, y) in plan.grid.y.iter().enumerate() {
            grid.push(line(
                [dx(level) - 800.0, *y],
                [xmax + dx(level) + 800.0, *y],
                "A-GRID",
            ));
            grid.push(text(&grid_letter(i), dx(level) - 1300.0, *y, 150.0));
        }
        grid.extend(
            columns(plan)
                .into_iter()
                .map(|r| poly(r.shifted(dx(level)), "A-COLS")),
        );
    }
    phases[0]
        .steps
        .push(json!({"op":"sysvar","set":{"INSUNITS":4,"OSMODE":0}}));
    run(&mut phases[0].steps, "UCS WORLD".into());
    let seeds = phases[0].steps.len();
    create(
        &mut phases[0].steps,
        AIA_LAYERS
            .iter()
            .map(|layer| line([0.0, 0.0], [1.0, 0.0], layer))
            .collect(),
    );
    phases[0].steps.push(json!({"op":"entities_delete","bindings":{"handles":{"step":seeds,"path":"/result/handles"}}}));
    create(&mut phases[0].steps, grid);

    let mut walls2d = Vec::new();
    for (wi, w) in solved.walls.iter().enumerate() {
        let mut cursor = w.start;
        for o in wall_segments(wi, &solved) {
            if o.start > cursor + EPS {
                walls2d.push(poly(
                    w.rect(cursor, o.start).shifted(dx(w.key.level)),
                    w.layer(),
                ));
            }
            cursor = o.end;
        }
        if cursor < w.end - EPS {
            walls2d.push(poly(
                w.rect(cursor, w.end).shifted(dx(w.key.level)),
                w.layer(),
            ));
        }
    }
    for room in &plan.rooms {
        walls2d.push(poly(
            room_rect(plan, room).shifted(dx(room.level)),
            "A-ANNO",
        ));
    }
    create(&mut phases[1].steps, walls2d);
    for (i, (o, s)) in plan.openings.iter().zip(&solved.openings).enumerate() {
        let w = &solved.walls[s.wall];
        let layer = if o.kind == OpeningKind::Door {
            "A-DOOR"
        } else {
            "A-GLAZ"
        };
        let (geometry, position) = if o.kind == OpeningKind::Door {
            let open = [s.inward[0] * o.width, s.inward[1] * o.width];
            let a = s.closed[1]
                .atan2(s.closed[0])
                .to_degrees()
                .rem_euclid(360.0);
            let b = s.inward[1]
                .atan2(s.inward[0])
                .to_degrees()
                .rem_euclid(360.0);
            let (start, end) = if (b - a).rem_euclid(360.0) < 180.0 {
                (a, a + 90.0)
            } else {
                (b, b + 90.0)
            };
            (
                vec![
                    line([0.0, 0.0], open, layer),
                    json!({"type":"Arc","layer":layer,"center":[0,0],"radius":o.width,"start_angle_deg":start,"end_angle_deg":end}),
                ],
                [s.hinge[0] + dx(w.key.level), s.hinge[1]],
            )
        } else {
            let rect = if w.key.axis == 0 {
                Rect {
                    x0: 0.0,
                    y0: -25.0,
                    x1: o.width,
                    y1: 25.0,
                }
            } else {
                Rect {
                    x0: -25.0,
                    y0: 0.0,
                    x1: 25.0,
                    y1: o.width,
                }
            };
            (
                vec![poly(rect, layer)],
                if w.key.axis == 0 {
                    [s.start + dx(w.key.level), w.coordinate]
                } else {
                    [w.coordinate + dx(w.key.level), s.start]
                },
            )
        };
        block(
            &mut phases[1].steps,
            &format!("OCSAEC_OPEN_{i}"),
            geometry,
            position,
            layer,
        );
    }
    for (s, g) in plan.stairs.iter().zip(&solved.stairs) {
        let mut entities = Vec::new();
        for level in [plan.rooms[g.lower].level, plan.rooms[g.upper].level] {
            entities.push(poly(g.footprint.shifted(dx(level)), "A-STAIR"));
            entities.push(poly(g.flight.shifted(dx(level)), "A-STAIR"));
            for n in 1..s.risers - 1 {
                let distance = f64::from(n) * g.going;
                let (a, b) = match s.direction {
                    StairDirection::East => (
                        [g.flight.x0 + distance + dx(level), g.flight.y0],
                        [g.flight.x0 + distance + dx(level), g.flight.y1],
                    ),
                    StairDirection::North => (
                        [g.flight.x0 + dx(level), g.flight.y0 + distance],
                        [g.flight.x1 + dx(level), g.flight.y0 + distance],
                    ),
                };
                entities.push(line(a, b, "A-STAIR"));
            }
            entities.push(text(
                &format!("UP {}R h={:.2} b={:.2}", s.risers, g.rise, g.going),
                g.footprint.x0 + dx(level),
                g.footprint.y0 - 250.0,
                120.0,
            ));
        }
        create(&mut phases[1].steps, entities);
    }
    for (i, f) in plan.furniture.iter().enumerate() {
        let level = plan.rooms[room_index(plan, &f.room)?].level;
        let local = Rect {
            x0: 0.0,
            y0: 0.0,
            x1: f.width,
            y1: f.depth,
        };
        let layer = if matches!(f.kind, FurnitureKind::Toilet | FurnitureKind::Sink) {
            "A-SANR"
        } else {
            "A-FURN"
        };
        let geometry = vec![
            poly(local, layer),
            line([0.0, 0.0], [f.width, f.depth], layer),
            line([f.width, 0.0], [0.0, f.depth], layer),
        ];
        block(
            &mut phases[2].steps,
            &format!("OCSAEC_FURN_{i}"),
            geometry,
            [f.x + dx(level), f.y],
            layer,
        );
        create(
            &mut phases[2].steps,
            vec![poly(
                furniture_rect(f).expanded(f.clearance).shifted(dx(level)),
                layer,
            )],
        );
    }

    let steps = &mut phases[3].steps;
    run(steps, "UCS WORLD".into());
    run(steps, "SETVAR DELOBJ 0".into());
    for recipe in solid_recipes(plan, &solved) {
        ensure!(
            !recipe_pieces(&recipe).is_empty(),
            "solid recipe unexpectedly removes every solid"
        );
        let mut groups: BTreeMap<(u64, u64), Vec<Prism>> = BTreeMap::new();
        for p in recipe.prisms {
            groups
                .entry((p.z0.to_bits(), p.z1.to_bits()))
                .or_default()
                .push(p);
        }
        for group in groups.values() {
            extrude(steps, group, recipe.layer, None);
        }
        for cutter in recipe.cutters {
            extrude(steps, &[cutter], "A-3D-ROOF", Some(recipe.layer));
        }
    }
    let steps = &mut phases[4].steps;
    run(steps, "UCS WORLD".into());
    // Dash DIMSTYLE accepts a JSON string array, not whitespace arguments.
    run(steps, format!("-DIMSTYLE {}", json!(["SAVE", "OCS_AEC"])));
    for (variable, value) in [
        ("DIMTXT", 180),
        ("DIMASZ", 150),
        ("DIMSCALE", 1),
        ("DIMLFAC", 1),
        ("DIMGAP", 60),
        ("DIMEXE", 120),
        ("DIMEXO", 100),
    ] {
        run(
            steps,
            format!(
                "-DIMSTYLE {}",
                json!(["VARIABLES", "OCS_AEC", variable, value.to_string()])
            ),
        );
    }
    run(steps, "CDIMSTY OCS_AEC".into());
    run(steps, "DIMLAYER A-DIMS".into());
    set_layer(steps, "A-DIMS");
    for (level, l) in plan.levels.iter().enumerate() {
        for pair in plan.grid.x.windows(2) {
            run(
                steps,
                format!(
                    "DIMLINEAR {},0 {},0 {},-1600",
                    pair[0] + dx(level),
                    pair[1] + dx(level),
                    (pair[0] + pair[1]) / 2.0 + dx(level)
                ),
            );
        }
        for pair in plan.grid.y.windows(2) {
            run(
                steps,
                format!(
                    "DIMLINEAR {},{} {},{} {},{}",
                    dx(level),
                    pair[0],
                    dx(level),
                    pair[1],
                    dx(level) - 1600.0,
                    (pair[0] + pair[1]) / 2.0
                ),
            );
        }
        run(
            steps,
            format!(
                "DIMLINEAR {},0 {},0 {},-2400",
                dx(level),
                xmax + dx(level),
                dx(level) + xmax / 2.0
            ),
        );
        run(
            steps,
            format!(
                "DIMLINEAR {},0 {},{} {},{}",
                dx(level),
                dx(level),
                ymax,
                dx(level) - 2400.0,
                ymax / 2.0
            ),
        );
        create(
            steps,
            vec![
                text(
                    &format!("{} / {}  FFL {} mm", plan.name, l.name, l.elevation),
                    dx(level),
                    ymax + 1800.0,
                    250.0,
                ),
                text(
                    "WALLS: EXTERIOR 200 mm / INTERIOR 100 mm",
                    dx(level),
                    ymax + 1200.0,
                    180.0,
                ),
                text(
                    "DOORS: WIDTH AS DIMENSIONED / HEAD 2200 mm",
                    dx(level),
                    ymax + 800.0,
                    180.0,
                ),
            ],
        );
    }
    for (_, opening) in plan
        .openings
        .iter()
        .zip(&solved.openings)
        .filter(|(o, _)| o.kind == OpeningKind::Door)
    {
        let w = &solved.walls[opening.wall];
        let shift = dx(w.key.level);
        let inward = if w.key.axis == 0 {
            opening.inward[1]
        } else {
            opening.inward[0]
        };
        let offset = w.coordinate - inward * if w.thickness == 200.0 { 800.0 } else { 600.0 };
        if w.key.axis == 0 {
            run(
                steps,
                format!(
                    "DIMLINEAR {},{} {},{} {},{}",
                    opening.start + shift,
                    w.coordinate,
                    opening.end + shift,
                    w.coordinate,
                    (opening.start + opening.end) / 2.0 + shift,
                    offset
                ),
            );
        } else {
            run(
                steps,
                format!(
                    "DIMLINEAR {},{} {},{} {},{}",
                    w.coordinate + shift,
                    opening.start,
                    w.coordinate + shift,
                    opening.end,
                    offset + shift,
                    (opening.start + opening.end) / 2.0
                ),
            );
        }
    }
    for r in &plan.rooms {
        create(steps, vec![room_label(plan, &solved, r, dx(r.level))]);
    }
    run(steps, "ZOOM E".into());
    bounded_phases(phases)
}
fn bounded_phases(phases: Vec<Phase>) -> Result<Vec<Phase>> {
    let mut batches = Vec::new();
    for phase in phases {
        if phase.steps.is_empty() {
            continue;
        }
        let mut forbidden = BTreeSet::new();
        for (target, step) in phase.steps.iter().enumerate() {
            if let Some(bindings) = step["bindings"].as_object() {
                for binding in bindings.values() {
                    let source = binding["step"]
                        .as_u64()
                        .context("invalid compiler binding")?
                        as usize;
                    ensure!(
                        source < target,
                        "compiler binding must reference earlier step"
                    );
                    forbidden.extend(source + 1..=target);
                }
            }
        }
        let mut start = 0;
        let mut part = 1;
        while start < phase.steps.len() {
            let mut prefix = Vec::new();
            if start > 0 {
                run(&mut prefix, "UCS WORLD".into());
                if phase.name.starts_with("4 ") {
                    run(&mut prefix, "SETVAR DELOBJ 0".into());
                }
                if let Some(layer) = phase.steps[..start]
                    .iter()
                    .rev()
                    .find(|s| s.get("set").and_then(|v| v.get("CLAYER")).is_some())
                {
                    prefix.push(layer.clone());
                }
            }
            let prefix_len = prefix.len();
            let mut end = (start + MAX_STEPS - prefix_len).min(phase.steps.len());
            while forbidden.contains(&end) {
                end -= 1;
            }
            ensure!(
                end > start,
                "inseparable compiler operation group exceeds 64 steps"
            );
            let mut steps = phase.steps[start..end].to_vec();
            for step in &mut steps {
                if let Some(bindings) = step.get_mut("bindings").and_then(Value::as_object_mut) {
                    for binding in bindings.values_mut() {
                        let source = binding["step"].as_u64().unwrap() as usize;
                        ensure!(source >= start, "binding crosses batch boundary");
                        binding["step"] = json!(source - start + prefix_len);
                    }
                }
            }
            let name = if phase.steps.len() > MAX_STEPS {
                format!("{} / batch {part}", phase.name)
            } else {
                phase.name.clone()
            };
            prefix.extend(steps);
            batches.push(Phase {
                name,
                steps: prefix,
            });
            start = end;
            part += 1;
        }
    }
    Ok(batches)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn minimal() -> MasterArchitecturalPlan {
        serde_json::from_str(
            planning_constraints()
                .lines()
                .find(|s| s.starts_with("{\"name\""))
                .unwrap(),
        )
        .unwrap()
    }
    fn stair_plan(risers: u8, direction: StairDirection) -> MasterArchitecturalPlan {
        let mut p = minimal();
        p.grid.x = vec![0.0, 9000.0];
        p.grid.y = vec![0.0, 9000.0];
        p.furniture.clear();
        let height = f64::from(risers) * 175.0;
        p.levels[0].height = height;
        p.levels.push(Level {
            name: "Upper".into(),
            elevation: height,
            height,
        });
        p.rooms[0].kind = RoomKind::Stair;
        let mut upper = p.rooms[0].clone();
        upper.id = "upper".into();
        upper.name = "Upper stair".into();
        upper.level = 1;
        p.rooms.push(upper);
        p.openings[0].offset = 7000.0;
        p.stairs.push(Stair {
            lower_room: "studio".into(),
            upper_room: "upper".into(),
            x: 500.0,
            y: 2000.0,
            width: 1000.0,
            risers,
            direction,
        });
        p
    }
    fn error(p: &MasterArchitecturalPlan, expected: &str) {
        let e = validate(p).unwrap_err().to_string();
        assert!(e.contains(expected), "expected {expected:?}, got {e:?}");
        assert!(compile(p).is_err());
    }
    fn volumes(plan: &MasterArchitecturalPlan) -> Vec<(String, Rect, f64, f64)> {
        solid_recipes(plan, &solve(plan).unwrap())
            .iter()
            .flat_map(|r| {
                recipe_pieces(r)
                    .into_iter()
                    .map(|p| (r.layer.to_string(), p.rect, p.z0, p.z1))
            })
            .collect()
    }
    #[test]
    fn minimal_example_compiles_deterministically_into_five_valid_phases() {
        let p = minimal();
        validate(&p).unwrap();
        let a = compile(&p).unwrap();
        let b = compile(&p).unwrap();
        assert_eq!(a.len(), 5);
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&b).unwrap()
        );
        assert!(a.iter().all(|p| !p.steps.is_empty() && p.steps.len() <= 64));
        assert!(a[1].steps.iter().any(|s| s["op"] == "block_define"));
        assert!(a[2].steps.iter().any(|s| s["op"] == "block_define"));
        assert!(a[4].steps.iter().any(|s| s["cmd"]
            .as_str()
            .is_some_and(|s| s.starts_with("DIMLINEAR "))));
        let solids = volumes(&p);
        assert!(!solids.is_empty());
        assert!(solids
            .iter()
            .all(|(l, _, _, _)| ["A-3D-SLAB", "A-3D-WALL", "A-3D-ROOF"].contains(&l.as_str())));
        let layers: BTreeSet<_> = a[0]
            .steps
            .iter()
            .flat_map(|s| s["entities"].as_array().into_iter().flatten())
            .filter_map(|e| e["layer"].as_str())
            .collect();
        assert_eq!(layers, AIA_LAYERS.iter().copied().collect());
    }
    #[test]
    fn schema_is_closed_required_nullable_and_validates_real_round_trip() {
        fn check(v: &Value) {
            if let Some(o) = v.as_object() {
                assert!(!o.contains_key("prefixItems"));
                assert!(!o.contains_key("$schema"));
                if o.get("type").and_then(Value::as_str) == Some("object") {
                    assert_eq!(o["additionalProperties"], false);
                    let properties = o["properties"].as_object().unwrap();
                    let required: BTreeSet<_> = o["required"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect();
                    assert_eq!(required, properties.keys().map(String::as_str).collect());
                }
                for child in o.values() {
                    check(child);
                }
            } else if let Some(a) = v.as_array() {
                for child in a {
                    check(child);
                }
            }
        }
        let schema = plan_schema();
        check(&schema);
        let validator = jsonschema::validator_for(&schema).unwrap();
        let value = serde_json::to_value(minimal()).unwrap();
        assert!(validator.is_valid(&value));
        let mut missing = value.clone();
        missing["rooms"][0]
            .as_object_mut()
            .unwrap()
            .remove("wet_stack");
        assert!(!validator.is_valid(&missing));
        let parsed: MasterArchitecturalPlan = serde_json::from_value(value.clone()).unwrap();
        validate(&parsed).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        let phases = compile(&minimal()).unwrap();
        let serialized = serde_json::to_value(&phases).unwrap();
        let decoded: Vec<Phase> = serde_json::from_value(serialized.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), serialized);
    }
    #[test]
    fn serde_rejects_unknown_fields_at_every_object_boundary() {
        let base = serde_json::to_value(minimal()).unwrap();
        for pointer in [
            "",
            "/grid",
            "/levels/0",
            "/rooms/0",
            "/rooms/0/rect",
            "/openings/0",
            "/furniture/0",
        ] {
            let mut value = base.clone();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), json!(true));
            assert!(
                serde_json::from_value::<MasterArchitecturalPlan>(value).is_err(),
                "{pointer}"
            );
        }
        let mut value = serde_json::to_value(stair_plan(17, StairDirection::East)).unwrap();
        value["stairs"][0]["unknown"] = json!(1);
        assert!(serde_json::from_value::<MasterArchitecturalPlan>(value).is_err());
        assert!(
            serde_json::from_value::<Phase>(json!({"name":"x","steps":[],"unknown":1})).is_err()
        );
    }
    #[test]
    fn rejects_bounds_nonfinite_bad_indices_and_incomplete_topology_without_panics() {
        let mut p = minimal();
        p.grid.x[1] = f64::NAN;
        error(&p, "finite");
        p = minimal();
        p.levels[0].height = f64::INFINITY;
        error(&p, "finite");
        p = minimal();
        p.grid.x.push(5900.0);
        error(&p, "grid bay");
        p = minimal();
        p.rooms[0].rect.x1 = usize::MAX;
        error(&p, "grid rectangle");
        p = minimal();
        p.rooms[0].level = usize::MAX;
        error(&p, "nonexistent level");
        p = minimal();
        p.grid.x.push(9000.0);
        error(&p, "tile");
        p = minimal();
        let mut duplicate = p.rooms[0].clone();
        duplicate.id = "duplicate".into();
        p.rooms.push(duplicate);
        error(&p, "overlapping room");
        p = minimal();
        p.column_size = 0.0;
        error(&p, "column size");
        p = minimal();
        p.furniture[0].clearance = 599.0;
        error(&p, "clearance");
    }
    #[test]
    fn shared_walls_are_unique_100mm_with_door_connectivity() {
        let mut p = minimal();
        p.furniture.clear();
        p.grid.x = vec![0.0, 4000.0, 8000.0];
        p.rooms[0].rect.x1 = 1;
        let mut other = p.rooms[0].clone();
        other.id = "other".into();
        other.rect.x0 = 1;
        other.rect.x1 = 2;
        p.rooms.push(other);
        error(&p, "every room must connect");
        let mut door = p.openings[0].clone();
        door.side = Side::East;
        door.offset = 2000.0;
        p.openings.push(door);
        let s = solve(&p).unwrap();
        assert_eq!(s.walls.iter().filter(|w| w.thickness == 100.0).count(), 1);
        assert_eq!(s.walls.iter().filter(|w| w.thickness == 200.0).count(), 6);
        compile(&p).unwrap();
        let mut duplicate = p.openings[1].clone();
        duplicate.room = "other".into();
        duplicate.side = Side::West;
        p.openings.push(duplicate);
        error(&p, "overlapping openings");
    }
    #[test]
    fn openings_have_real_door_void_window_sill_and_lintel() {
        let mut p = minimal();
        p.furniture.clear();
        let mut window = p.openings[0].clone();
        window.kind = OpeningKind::Window;
        window.offset = 3000.0;
        window.width = 1200.0;
        window.sill = 900.0;
        window.height = 1200.0;
        p.openings.push(window);
        compile(&p).unwrap();
        let boxes = volumes(&p);
        for (x, z) in [(1450.0, 1000.0), (3600.0, 1500.0)] {
            let sample = Rect {
                x0: x - 1.0,
                x1: x + 1.0,
                y0: -1.0,
                y1: 1.0,
            };
            assert!(boxes
                .iter()
                .all(|(_, b, z0, z1)| !b.overlaps(sample) || z <= *z0 || z >= *z1));
        }
        for (x, z) in [(1450.0, 2400.0), (3600.0, 500.0), (3600.0, 2400.0)] {
            let sample = Rect {
                x0: x - 1.0,
                x1: x + 1.0,
                y0: -1.0,
                y1: 1.0,
            };
            assert!(boxes.iter().any(|(l, b, z0, z1)| l == "A-3D-WALL"
                && b.overlaps(sample)
                && z > *z0
                && z < *z1));
        }
        p.openings[1].offset = 1800.0;
        error(&p, "overlapping openings");
        p = minimal();
        p.openings[0].offset = 100.0;
        error(&p, "clear of columns");
        p = minimal();
        p.openings[0].height = 2700.0;
        error(&p, "lintel");
    }
    #[test]
    fn all_eight_door_orientations_have_quarter_arcs_and_bounded_swings() {
        for side in [Side::South, Side::East, Side::North, Side::West] {
            for hinge_end in [false, true] {
                let mut p = minimal();
                p.furniture.clear();
                p.openings[0].side = side;
                p.openings[0].hinge_end = hinge_end;
                let solved = solve(&p).unwrap();
                let b = solved.openings[0].swing.unwrap();
                assert!((b.x1 - b.x0 - 900.0).abs() < EPS && (b.y1 - b.y0 - 900.0).abs() < EPS);
                let phases = compile(&p).unwrap();
                let arc = phases[1]
                    .steps
                    .iter()
                    .flat_map(|s| s["entities"].as_array().into_iter().flatten())
                    .find(|e| e["type"] == "Arc")
                    .unwrap();
                assert_eq!(
                    arc["end_angle_deg"].as_f64().unwrap()
                        - arc["start_angle_deg"].as_f64().unwrap(),
                    90.0
                );
            }
        }
    }
    #[test]
    fn ergonomic_solver_rejects_actual_and_reserved_collisions() {
        let mut p = minimal();
        let mut f = p.furniture[0].clone();
        f.x += 100.0;
        p.furniture.push(f);
        error(&p, "ergonomic envelopes collide");
        p = minimal();
        p.furniture[0].x = 1100.0;
        p.furniture[0].y = 800.0;
        error(&p, "door swing intersects furniture");
        p = minimal();
        p.furniture[0].x = 100.0;
        error(&p, "leaves clear room");
        p = minimal();
        p.grid.x = vec![0.0, 3000.0, 6000.0];
        p.grid.y = vec![0.0, 3000.0, 6000.0];
        p.rooms[0].rect.x1 = 2;
        p.rooms[0].rect.y1 = 2;
        error(&p, "clearance intersects column");
        p = minimal();
        p.furniture[0].kind = FurnitureKind::Toilet;
        p.furniture[0].depth = 700.0;
        error(&p, "vertically aligned wet room");
    }
    #[test]
    fn wet_stack_alignment_and_missing_floor_are_rejected() {
        let mut p = stair_plan(17, StairDirection::East);
        for axis in [&mut p.grid.x, &mut p.grid.y] {
            axis.push(12000.0);
        }
        // Complete the added right/top strips with aligned wet rooms and dry rooms.
        for level in 0..2 {
            p.rooms.push(Room {
                id: format!("wet{level}"),
                name: "Wet".into(),
                level,
                rect: GridRect {
                    x0: 1,
                    y0: 0,
                    x1: 2,
                    y1: 2,
                },
                kind: RoomKind::Wet,
                wet_stack: Some("W".into()),
            });
            p.rooms.push(Room {
                id: format!("dry{level}"),
                name: "Dry".into(),
                level,
                rect: GridRect {
                    x0: 0,
                    y0: 1,
                    x1: 1,
                    y1: 2,
                },
                kind: RoomKind::Dry,
                wet_stack: None,
            });
        }
        let mut q = p.clone();
        q.rooms[4].rect.y1 = 1;
        error(&q, "must align exactly");
        q = p.clone();
        q.rooms[4].wet_stack = Some("other".into());
        error(&q, "must align exactly");
        q = minimal();
        q.rooms[0].kind = RoomKind::Wet;
        error(&q, "requires wet_stack");
        q = minimal();
        q.rooms[0].wet_stack = Some("W".into());
        error(&q, "only wet rooms");
        q = minimal();
        q.rooms[0].kind = RoomKind::Wet;
        q.rooms[0].wet_stack = Some("W".into());
        validate(&q).unwrap();
    }
    #[test]
    fn odd_stair_solver_and_actual_upper_slab_voids() {
        for risers in [17, 21, 25] {
            for direction in [StairDirection::East, StairDirection::North] {
                let mut p = stair_plan(risers, direction);
                if direction == StairDirection::North {
                    p.stairs[0].y = 500.0;
                }
                let solved = solve(&p).unwrap();
                let s = &solved.stairs[0];
                assert!((2.0 * s.rise + s.going - 600.0).abs() < EPS);
                assert_eq!(s.rise, 175.0);
                assert_eq!(s.going, 250.0);
                compile(&p).unwrap();
                let boxes = volumes(&p);
                let upper_z = p.levels[1].elevation;
                let slabs: Vec<_> = boxes
                    .iter()
                    .filter(|(l, _, _, z1)| l == "A-3D-SLAB" && (*z1 - upper_z).abs() < EPS)
                    .collect();
                assert_eq!(slabs.len(), 4);
                assert!(slabs.iter().all(|(_, r, _, _)| !r.overlaps(s.flight)));
                let stair_steps: Vec<_> = boxes
                    .iter()
                    .filter(|(l, r, _, z1)| {
                        l == "A-3D-WALL" && r.overlaps(s.flight) && *z1 < upper_z - EPS
                    })
                    .collect();
                assert_eq!(stair_steps.len(), usize::from(risers - 1));
            }
        }
    }
    #[test]
    fn stairs_reject_bad_steps_headroom_alignment_and_obstacles() {
        let mut p = stair_plan(17, StairDirection::East);
        p.stairs[0].risers = 18;
        error(&p, "17, 21 or 25");
        p = stair_plan(17, StairDirection::East);
        p.stairs[0].width = 900.0;
        error(&p, "stair width");
        p = stair_plan(25, StairDirection::East);
        p.stairs[0].x = 3000.0;
        error(&p, "landings must fit");
        p = stair_plan(17, StairDirection::East);
        p.levels[0].height = 4800.0;
        p.levels[1].elevation = 4800.0;
        error(&p, "riser height");
        p = stair_plan(17, StairDirection::East);
        p.openings[0].side = Side::West;
        p.openings[0].offset = 2300.0;
        error(&p, "intersects stairs/landing");
        p = stair_plan(17, StairDirection::East);
        p.stairs.clear();
        error(&p, "requires a stair");
    }
    #[test]
    fn slab_difference_has_exact_area_no_overlaps_and_handles_edge_cuts() {
        let base = Rect {
            x0: 0.0,
            y0: 0.0,
            x1: 100.0,
            y1: 100.0,
        };
        for hole in [
            Rect {
                x0: 20.0,
                y0: 30.0,
                x1: 80.0,
                y1: 70.0,
            },
            base,
            Rect {
                x0: -20.0,
                y0: 30.0,
                x1: 80.0,
                y1: 170.0,
            },
        ] {
            let pieces = subtract_rect(base, hole);
            for (i, a) in pieces.iter().enumerate() {
                assert!(base.contains(*a));
                assert!(!a.overlaps(hole));
                assert!(pieces[..i].iter().all(|b| !a.overlaps(*b)));
            }
            let area: f64 = pieces.iter().map(|r| (r.x1 - r.x0) * (r.y1 - r.y0)).sum();
            let removed = (base.x1.min(hole.x1) - base.x0.max(hole.x0))
                * (base.y1.min(hole.y1) - base.y0.max(hole.y0));
            assert!((area + removed - 10000.0).abs() < EPS);
        }
    }
    #[test]
    fn large_compiler_batches_preserve_groups_and_rebase_all_bindings() {
        let mut p = minimal();
        p.furniture.clear();
        p.grid.x = (0..9).map(|i| f64::from(i) * 3000.0).collect();
        p.grid.y = p.grid.x.clone();
        p.rooms[0].rect.x1 = 8;
        p.rooms[0].rect.y1 = 8;
        let phases = compile(&p).unwrap();
        assert!(phases.len() >= 4);
        for phase in &phases {
            assert!(!phase.steps.is_empty() && phase.steps.len() <= 64);
            for (target, step) in phase.steps.iter().enumerate() {
                if let Some(bindings) = step["bindings"].as_object() {
                    for binding in bindings.values() {
                        let source = binding["step"].as_u64().unwrap() as usize;
                        assert!(source < target);
                        assert_eq!(binding.as_object().unwrap().len(), 2);
                        assert_eq!(phase.steps[source]["op"], "entities_create");
                    }
                }
            }
        }
        // Repeated actual block groups straddle the naive 64-step boundaries.
        let mut p = minimal();
        p.furniture.clear();
        p.openings.clear();
        p.grid.x = vec![0.0, 12000.0];
        p.grid.y = vec![0.0, 12000.0];
        for side in [Side::South, Side::North, Side::East, Side::West] {
            for i in 0..6 {
                p.openings.push(Opening {
                    room: "studio".into(),
                    side,
                    kind: OpeningKind::Window,
                    offset: 500.0 + f64::from(i) * 1800.0,
                    width: 1200.0,
                    sill: 900.0,
                    height: 1200.0,
                    hinge_end: false,
                });
            }
        }
        p.openings[0].kind = OpeningKind::Door;
        p.openings[0].width = 900.0;
        p.openings[0].sill = 0.0;
        p.openings[0].height = 2200.0;
        let phases = compile(&p).unwrap();
        assert!(phases.iter().filter(|p| p.name.starts_with("2 ")).count() > 1);
        assert_eq!(
            phases
                .iter()
                .flat_map(|p| &p.steps)
                .filter(|s| s["op"] == "block_define")
                .count(),
            24
        );
        for phase in phases {
            for (i, step) in phase
                .steps
                .iter()
                .enumerate()
                .filter(|(_, s)| s["op"] == "block_define")
            {
                assert_eq!(
                    step["bindings"]["handles"]["step"].as_u64().unwrap() as usize,
                    i - 1
                );
                assert_eq!(phase.steps[i - 1]["op"], "entities_create");
            }
        }
    }
    #[test]
    fn batch_regression_never_inserts_null_or_empty_bindings_and_omits_empty_phases() {
        let mut p = minimal();
        p.furniture.clear();
        let phases = compile(&p).unwrap();
        assert!(!phases.iter().any(|p| p.name.starts_with("3 ")));
        for phase in phases {
            assert!(!phase.steps.is_empty() && phase.steps.len() <= 64);
            for step in phase.steps {
                if let Some(bindings) = step.get("bindings") {
                    let object = bindings.as_object().expect("bindings must never be null");
                    assert!(!object.is_empty());
                    assert!(object
                        .values()
                        .all(|source| source.as_object().unwrap().len() == 2));
                } else {
                    assert!(step.get("bindings").is_none());
                }
            }
        }
    }
    #[test]
    fn compiled_extrusion_boolean_recipes_keep_interactive_groups_bound_and_complete() {
        let p = stair_plan(17, StairDirection::East);
        let recipes = solid_recipes(&p, &solve(&p).unwrap());
        let count: usize = recipes
            .iter()
            .map(|r| r.prisms.len() + r.cutters.len())
            .sum();
        let expected_cuts: usize = recipes.iter().map(|r| r.cutters.len()).sum();
        let mut profiles = 0;
        let mut cuts = 0;
        let mut extrusions = 0;
        for phase in compile(&p)
            .unwrap()
            .into_iter()
            .filter(|p| p.name.starts_with("4 "))
        {
            assert!(phase.steps.len() <= 64);
            for (i, step) in phase.steps.iter().enumerate() {
                assert!(!step["cmd"].as_str().is_some_and(|s| s.starts_with("BOX ")));
                if step["op"] == "entities_create" {
                    for e in step["entities"].as_array().unwrap() {
                        assert_eq!(e["type"], "LwPolyline");
                        assert_eq!(e["closed"], true);
                        assert_eq!(e["vertices"].as_array().unwrap().len(), 4);
                        assert!(e["layer"].as_str().unwrap().starts_with("A-3D-"));
                        profiles += 1;
                    }
                }
                if step["op"] == "start" && step["cmd"] == "EXTRUDE" {
                    extrusions += 1;
                    let inputs = &phase.steps[i + 1..i + 8];
                    assert!(inputs.iter().all(|s| s["op"] == "input"));
                    assert_eq!(inputs[0]["text"], "Mode");
                    assert_eq!(inputs[1]["text"], "Solid");
                    let source =
                        inputs[2]["bindings"]["handles"]["step"].as_u64().unwrap() as usize;
                    assert!(source < i);
                    assert_eq!(phase.steps[source]["op"], "entities_create");
                    assert_eq!(inputs[3]["kind"], "enter");
                    assert_eq!(inputs[4]["text"], "Taper");
                    assert_eq!(inputs[5]["text"], "0");
                    assert!(inputs[6]["text"].as_str().unwrap().parse::<f64>().unwrap() > 0.0);
                    assert!(phase.steps[i + 8..]
                        .iter()
                        .any(|s| s["op"] == "entities_delete"
                            && s["bindings"]["handles"]["step"].as_u64() == Some(source as u64)));
                }
                if step["op"] == "start" && step["cmd"] == "SUBTRACT" {
                    cuts += 1;
                    assert_eq!(phase.steps[i - 1]["op"], "select");
                    assert_eq!(phase.steps[i - 1]["type"], "3DSOLID");
                    assert_eq!(phase.steps[i + 1]["op"], "input");
                    assert_eq!(phase.steps[i + 1]["text"], "Last");
                    assert_eq!(phase.steps[i + 2]["kind"], "enter");
                    assert_eq!(phase.steps[i + 3]["op"], "entities_delete");
                }
            }
        }
        assert_eq!(profiles, count);
        assert_eq!(cuts, expected_cuts);
        assert!(extrusions > 0 && cuts > 0);
    }
    #[test]
    fn standards_and_nearer_wall_hinges_are_deterministic() {
        let mut p = minimal();
        p.openings[0].height = 2100.0;
        error(&p, "height=2200");
        p = minimal();
        p.furniture[0].clearance = 650.0;
        error(&p, "clearance");
        p = minimal();
        p.furniture[0].kind = FurnitureKind::Cabinet;
        p.furniture[0].clearance = 650.0;
        error(&p, "clearance");
        p = minimal();
        p.furniture.clear();
        p.openings[0].hinge_end = true;
        let s = solve(&p).unwrap();
        assert_eq!(s.openings[0].hinge[0], 1000.0);
        p.openings[0].offset = 4000.0;
        p.openings[0].hinge_end = false;
        let s = solve(&p).unwrap();
        assert_eq!(s.openings[0].hinge[0], 4900.0);
        p.openings[0].kind = OpeningKind::Window;
        p.openings[0].height = 1200.0;
        p.openings[0].sill = 600.0;
        error(&p, "sill=900");
    }
    #[test]
    fn aligned_multilevel_wet_stacks_compile_with_sanitary_blocks_and_reachable_rooms() {
        let mut p = stair_plan(17, StairDirection::East);
        p.grid.x.push(12000.0);
        p.grid.y.push(12000.0);
        for level in 0..2 {
            p.rooms.push(Room {
                id: format!("wet{level}"),
                name: "Wet room".into(),
                level,
                rect: GridRect {
                    x0: 1,
                    y0: 0,
                    x1: 2,
                    y1: 2,
                },
                kind: RoomKind::Wet,
                wet_stack: Some("W".into()),
            });
            p.rooms.push(Room {
                id: format!("dry{level}"),
                name: "Dry room".into(),
                level,
                rect: GridRect {
                    x0: 0,
                    y0: 1,
                    x1: 1,
                    y1: 2,
                },
                kind: RoomKind::Dry,
                wet_stack: None,
            });
            for side in [Side::North, Side::East] {
                p.openings.push(Opening {
                    room: if level == 0 {
                        "studio".into()
                    } else {
                        "upper".into()
                    },
                    side,
                    kind: OpeningKind::Door,
                    offset: 4000.0,
                    width: 900.0,
                    sill: 0.0,
                    height: 2200.0,
                    hinge_end: false,
                });
            }
            p.furniture.push(Furniture {
                room: format!("wet{level}"),
                kind: FurnitureKind::Sink,
                x: 10000.0,
                y: 5000.0,
                width: 500.0,
                depth: 450.0,
                clearance: 600.0,
            });
        }
        validate(&p).unwrap();
        let phases = compile(&p).unwrap();
        assert!(phases.iter().any(|p| p.name.starts_with("3 ")));
        let sanitary: Vec<_> = phases
            .iter()
            .filter(|p| p.name.starts_with("3 "))
            .flat_map(|p| &p.steps)
            .flat_map(|s| s["entities"].as_array().into_iter().flatten())
            .collect();
        assert!(!sanitary.is_empty());
        assert!(sanitary.iter().all(|e| e["layer"] == "A-SANR"));
    }
    #[test]
    fn grid_axes_are_numeric_and_alphabetic() {
        assert_eq!(grid_letter(0), "A");
        assert_eq!(grid_letter(25), "Z");
        assert_eq!(grid_letter(26), "AA");
        assert_eq!(grid_letter(701), "ZZ");
        let phases = compile(&minimal()).unwrap();
        let text = phases
            .iter()
            .flat_map(|p| p.steps.iter())
            .filter_map(|s| s.get("entities").and_then(Value::as_array))
            .flatten()
            .filter_map(|e| e.get("value").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(text.contains(&"1") && text.contains(&"A"));
        assert!(!text.contains(&"X1") && !text.contains(&"Y1"));
    }
    #[test]
    fn annotation_dimensions_use_readable_style_overall_sizes_and_actual_door_width() {
        let mut p = minimal();
        p.grid.x = vec![0.0, 3000.0, 6000.0];
        p.grid.y = vec![0.0, 4000.0, 8000.0];
        p.rooms[0].rect.x1 = 2;
        p.rooms[0].rect.y1 = 2;
        p.furniture.clear();
        let phases = compile(&p).unwrap();
        let commands: Vec<_> = phases
            .iter()
            .filter(|p| p.name.starts_with("5 "))
            .flat_map(|p| &p.steps)
            .filter_map(|s| s["cmd"].as_str())
            .collect();
        for expected in [
            r#"-DIMSTYLE ["SAVE","OCS_AEC"]"#,
            r#"-DIMSTYLE ["VARIABLES","OCS_AEC","DIMTXT","180"]"#,
            r#"-DIMSTYLE ["VARIABLES","OCS_AEC","DIMASZ","150"]"#,
            r#"-DIMSTYLE ["VARIABLES","OCS_AEC","DIMSCALE","1"]"#,
            "CDIMSTY OCS_AEC",
            "DIMLAYER A-DIMS",
        ] {
            assert!(commands.contains(&expected));
        }
        for command in commands.iter().filter(|s| s.starts_with("-DIMSTYLE ")) {
            let arguments: Vec<String> =
                serde_json::from_str(command.strip_prefix("-DIMSTYLE ").unwrap()).unwrap();
            assert!(!arguments.is_empty());
            assert!(arguments[0] == "SAVE" || arguments[0] == "VARIABLES");
        }
        let dimensions: Vec<_> = commands
            .iter()
            .filter(|s| s.starts_with("DIMLINEAR "))
            .map(|s| {
                s.split_whitespace()
                    .skip(1)
                    .map(|point| {
                        point
                            .split(',')
                            .map(|v| v.parse::<f64>().unwrap())
                            .collect::<Vec<_>>()
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let measured: Vec<_> = dimensions
            .iter()
            .map(|points| (points[0][0] - points[1][0]).hypot(points[0][1] - points[1][1]))
            .collect();
        for value in [3000.0, 4000.0, 6000.0, 8000.0, 900.0] {
            assert!(measured.contains(&value), "missing dimension {value}");
        }
        assert!(dimensions.iter().any(|d| d[2][1] == -2400.0));
        assert!(dimensions.iter().any(|d| d[2][0] == 7600.0));
        let labels: Vec<_> = phases
            .iter()
            .filter(|p| p.name.starts_with("5 "))
            .flat_map(|p| &p.steps)
            .flat_map(|s| s["entities"].as_array().into_iter().flatten())
            .filter_map(|e| e["value"].as_str())
            .collect();
        assert!(labels
            .iter()
            .any(|s| s.contains("EXTERIOR 200 mm / INTERIOR 100 mm")));
    }
    #[test]
    fn room_labels_use_bay_interior_not_internal_grid_axes_and_wrap_long_names() {
        let mut p = minimal();
        p.furniture.clear();
        p.grid.x = vec![0.0, 3000.0, 6000.0];
        p.grid.y = vec![0.0, 3000.0, 6000.0];
        p.rooms[0].rect.x1 = 2;
        p.rooms[0].rect.y1 = 2;
        let label = room_label(&p, &solve(&p).unwrap(), &p.rooms[0], 0.0);
        assert_eq!(label["type"], "MText");
        let x = label["position"][0].as_f64().unwrap();
        let width = label["width"].as_f64().unwrap();
        assert!(p
            .grid
            .x
            .windows(2)
            .any(|bay| x >= bay[0] + 350.0 && x + width <= bay[1] - 350.0));
        assert_ne!(x + width / 2.0, 3000.0);
        p.grid.x = vec![0.0, 1500.0];
        p.grid.y = vec![0.0, 1500.0];
        p.rooms[0].rect.x1 = 1;
        p.rooms[0].rect.y1 = 1;
        p.openings[0].offset = 300.0;
        p.openings[0].width = 600.0;
        p.rooms[0].name = "A very long descriptive room label ".repeat(2);
        let label = room_label(&p, &solve(&p).unwrap(), &p.rooms[0], 0.0);
        assert!(label["height"].as_f64().unwrap() < 180.0);
        assert_eq!(label["width"], 800.0);
        assert_eq!(label["value"], p.rooms[0].name);
    }
}
