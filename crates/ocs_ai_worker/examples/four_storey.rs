use anyhow::{ensure, Context, Result};
use ocs_ai_worker::spatial::{self, *};
use serde_json::{json, Value};
use std::{collections::BTreeSet, env, fs, path::PathBuf};
const HEIGHT: f64 = 3570.0;
fn room_id(level: usize, name: &str) -> String {
    format!("L{}_{}", level + 1, name)
}
fn house() -> MasterArchitecturalPlan {
    let mut p = MasterArchitecturalPlan {
        name: "Four storey 10x15m architectural schematic".into(),
        grid: StructuralGrid {
            x: vec![0., 5000., 10000.],
            y: vec![0., 4500., 8200., 11600., 15000.],
        },
        levels: (0..4)
            .map(|i| Level {
                name: format!("Floor {}", i + 1),
                elevation: i as f64 * HEIGHT,
                height: HEIGHT,
            })
            .collect(),
        rooms: vec![],
        openings: vec![],
        furniture: vec![],
        stairs: vec![],
        slab_thickness: 200.,
        roof_thickness: 200.,
        column_size: 300.,
    };
    for l in 0..4 {
        let mut room = |id: &str, name: &str, rect: [usize; 4], kind, stack: Option<&str>| {
            p.rooms.push(Room {
                id: room_id(l, id),
                name: name.into(),
                level: l,
                rect: GridRect {
                    x0: rect[0],
                    y0: rect[1],
                    x1: rect[2],
                    y1: rect[3],
                },
                kind,
                wet_stack: stack.map(str::to_owned),
            });
        };
        room(
            "living",
            if l == 3 {
                "Worship and study"
            } else {
                "Living room"
            },
            [0, 0, 1, 1],
            RoomKind::Dry,
            None,
        );
        room(
            "kitchen",
            if l == 3 {
                "Kitchen dining and laundry"
            } else {
                "Kitchen and dining"
            },
            [1, 0, 2, 1],
            RoomKind::Wet,
            Some("KITCHEN"),
        );
        room(
            "stair",
            "Stair and circulation hall",
            [0, 1, 2, 2],
            RoomKind::Stair,
            None,
        );
        room(
            "bed1",
            if l == 3 {
                "Multipurpose guest bedroom"
            } else {
                "Bedroom 1"
            },
            [0, 2, 1, 3],
            RoomKind::Dry,
            None,
        );
        room(
            "bed2",
            if l == 3 {
                "Study and guest bedroom"
            } else {
                "Bedroom 2"
            },
            [0, 3, 1, 4],
            RoomKind::Dry,
            None,
        );
        room(
            "wc",
            "WC wash and utility",
            [1, 2, 2, 4],
            RoomKind::Wet,
            Some("SANITARY"),
        );
        let mut opening = |id: &str, side, kind, offset, width| {
            p.openings.push(Opening {
                room: room_id(l, id),
                side,
                kind,
                offset,
                width,
                sill: if kind == OpeningKind::Door { 0. } else { 900. },
                height: if kind == OpeningKind::Door {
                    2200.
                } else {
                    1500.
                },
                hinge_end: false,
            });
        };
        opening("living", Side::North, OpeningKind::Door, 500., 900.);
        opening("kitchen", Side::North, OpeningKind::Door, 500., 900.);
        opening("bed1", Side::South, OpeningKind::Door, 500., 900.);
        opening("bed2", Side::South, OpeningKind::Door, 3900., 800.);
        opening("wc", Side::South, OpeningKind::Door, 500., 900.);
        if l == 0 {
            opening("living", Side::South, OpeningKind::Door, 500., 1000.);
        }
        for (id, side, offset, width) in [
            ("living", Side::South, 2500., 1800.),
            ("living", Side::West, 1800., 1500.),
            ("kitchen", Side::East, 1000., 1600.),
            ("bed1", Side::West, 900., 1400.),
            ("bed2", Side::West, 1000., 1400.),
            ("bed2", Side::North, 1500., 1800.),
            ("wc", Side::East, 1000., 1200.),
            ("wc", Side::East, 4200., 1400.),
            ("wc", Side::North, 1400., 1600.),
            ("stair", Side::East, 300., 1500.),
            ("stair", Side::West, 1800., 1400.),
        ] {
            opening(id, side, OpeningKind::Window, offset, width);
        }
        let mut furnish = |id: &str, kind, x, y, width, depth, clearance| {
            p.furniture.push(Furniture {
                room: room_id(l, id),
                kind,
                x,
                y,
                width,
                depth,
                clearance,
            });
        };
        furnish(
            "living",
            if l == 3 {
                FurnitureKind::Table
            } else {
                FurnitureKind::Sofa
            },
            2500.,
            1000.,
            1600.,
            800.,
            600.,
        );
        furnish(
            "living",
            FurnitureKind::Desk,
            3200.,
            3100.,
            900.,
            600.,
            700.,
        );
        furnish(
            "kitchen",
            FurnitureKind::Table,
            6500.,
            1000.,
            1600.,
            900.,
            600.,
        );
        furnish(
            "kitchen",
            FurnitureKind::Sink,
            7600.,
            3250.,
            600.,
            450.,
            600.,
        );
        furnish("bed1", FurnitureKind::Bed, 2400., 9000., 1500., 1900., 600.);
        furnish(
            "bed2",
            FurnitureKind::Bed,
            1500.,
            12300.,
            1500.,
            1900.,
            600.,
        );
        furnish("wc", FurnitureKind::Toilet, 6500., 10000., 500., 750., 600.);
        furnish("wc", FurnitureKind::Sink, 8200., 12500., 700., 500., 600.);
    }
    for l in 0..3 {
        p.stairs.push(Stair {
            lower_room: room_id(l, "stair"),
            upper_room: room_id(l + 1, "stair"),
            x: 1400.,
            y: 4650. + l as f64 * 1150.,
            width: 1000.,
            risers: 21,
            direction: StairDirection::East,
        });
    }
    p
}
#[derive(Clone, Copy, Debug)]
struct Box3 {
    lo: [f64; 3],
    hi: [f64; 3],
}
impl Box3 {
    fn new(x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> Self {
        Self {
            lo: [x0, y0, z0],
            hi: [x1, y1, z1],
        }
    }
    fn subtract(self, hole: Self) -> Vec<Self> {
        let a = std::array::from_fn::<_, 3, _>(|i| self.lo[i].max(hole.lo[i]));
        let b = std::array::from_fn::<_, 3, _>(|i| self.hi[i].min(hole.hi[i]));
        if (0..3).any(|i| a[i] >= b[i]) {
            return vec![self];
        }
        let mut core = self;
        let mut out = vec![];
        for i in 0..3 {
            if core.lo[i] < a[i] {
                let mut part = core;
                part.hi[i] = a[i];
                out.push(part);
                core.lo[i] = a[i];
            }
            if core.hi[i] > b[i] {
                let mut part = core;
                part.lo[i] = b[i];
                out.push(part);
                core.hi[i] = b[i];
            }
        }
        out
    }
}
fn dimensions(p: &MasterArchitecturalPlan) -> (f64, f64) {
    (*p.grid.x.last().unwrap(), *p.grid.y.last().unwrap())
}
fn room<'a>(p: &'a MasterArchitecturalPlan, id: &str) -> &'a Room {
    p.rooms.iter().find(|r| r.id == id).unwrap()
}
fn bounds(p: &MasterArchitecturalPlan, r: &Room) -> [f64; 4] {
    [
        p.grid.x[r.rect.x0],
        p.grid.y[r.rect.y0],
        p.grid.x[r.rect.x1],
        p.grid.y[r.rect.y1],
    ]
}
fn opening_bounds(p: &MasterArchitecturalPlan, o: &Opening) -> (usize, f64, f64, f64) {
    let r = room(p, &o.room);
    let [x0, y0, x1, y1] = bounds(p, r);
    match o.side {
        Side::South => (0, y0, x0 + o.offset, x0 + o.offset + o.width),
        Side::North => (0, y1, x0 + o.offset, x0 + o.offset + o.width),
        Side::West => (1, x0, y0 + o.offset, y0 + o.offset + o.width),
        Side::East => (1, x1, y0 + o.offset, y0 + o.offset + o.width),
    }
}
fn flight(p: &MasterArchitecturalPlan, s: &Stair) -> Box3 {
    let low = room(p, &s.lower_room).level;
    let z = p.levels[low].elevation;
    let h = (p.levels[low + 1].elevation - z) / f64::from(s.risers);
    let run = f64::from(s.risers - 1) * (600. - 2. * h);
    match s.direction {
        StairDirection::East => Box3::new(
            s.x + 1000.,
            s.y,
            z,
            s.x + 1000. + run,
            s.y + s.width,
            z + HEIGHT,
        ),
        StairDirection::North => Box3::new(
            s.x,
            s.y + 1000.,
            z,
            s.x + s.width,
            s.y + 1000. + run,
            z + HEIGHT,
        ),
    }
}
// These section boxes follow the compiler's architectural solids, including its slab holes.
fn model_boxes(p: &MasterArchitecturalPlan) -> Vec<(Box3, &'static str)> {
    let (w, d) = dimensions(p);
    let c = p.column_size / 2.;
    let mut out = vec![];
    for (l, level) in p.levels.iter().enumerate() {
        let z = level.elevation;
        let top = z + level.height - p.slab_thickness;
        let mut slabs = vec![Box3::new(-c, -c, z - p.slab_thickness, w + c, d + c, z)];
        for s in &p.stairs {
            if room(p, &s.upper_room).level == l {
                let mut hole = flight(p, s);
                hole.lo[2] = z - p.slab_thickness - 1.;
                hole.hi[2] = z + 1.;
                slabs = slabs.into_iter().flat_map(|b| b.subtract(hole)).collect();
            }
        }
        out.extend(slabs.into_iter().map(|b| (b, "A-3D-SLAB")));
        let mut walls = vec![];
        for &x in &p.grid.x {
            for &y in &p.grid.y {
                walls.push(Box3::new(x - c, y - c, z, x + c, y + c, top));
            }
        }
        for axis in 0..2 {
            let (along, across) = if axis == 0 {
                (&p.grid.x, &p.grid.y)
            } else {
                (&p.grid.y, &p.grid.x)
            };
            for (li, &coord) in across.iter().enumerate() {
                for span in along.windows(2) {
                    let mid = (span[0] + span[1]) / 2.;
                    let owner = |side: f64| {
                        p.rooms
                            .iter()
                            .find(|r| {
                                if r.level != l {
                                    return false;
                                }
                                let [x0, y0, x1, y1] = bounds(p, r);
                                let (x, y) = if axis == 0 {
                                    (mid, coord + side)
                                } else {
                                    (coord + side, mid)
                                };
                                x > x0 && x < x1 && y > y0 && y < y1
                            })
                            .map(|r| r.id.as_str())
                    };
                    if owner(-1.) == owner(1.) {
                        continue;
                    }
                    let t = if li == 0 || li + 1 == across.len() {
                        100.
                    } else {
                        50.
                    };
                    walls.push(if axis == 0 {
                        Box3::new(span[0], coord - t, z, span[1], coord + t, top)
                    } else {
                        Box3::new(coord - t, span[0], z, coord + t, span[1], top)
                    });
                }
            }
        }
        for o in p.openings.iter().filter(|o| room(p, &o.room).level == l) {
            let (axis, coord, a, b) = opening_bounds(p, o);
            let exterior = if axis == 0 {
                coord == 0. || coord == d
            } else {
                coord == 0. || coord == w
            };
            let t = if exterior { 110. } else { 60. };
            let bottom = z + o.sill - if o.kind == OpeningKind::Door { 1. } else { 0. };
            let hole = if axis == 0 {
                Box3::new(a, coord - t, bottom, b, coord + t, z + o.sill + o.height)
            } else {
                Box3::new(coord - t, a, bottom, coord + t, b, z + o.sill + o.height)
            };
            walls = walls.into_iter().flat_map(|b| b.subtract(hole)).collect();
        }
        out.extend(walls.into_iter().map(|b| (b, "A-3D-WALL")));
    }
    for s in &p.stairs {
        let f = flight(p, s);
        let rise = (f.hi[2] - f.lo[2]) / f64::from(s.risers);
        let going = 600. - 2. * rise;
        for n in 0..s.risers - 1 {
            let mut b = f;
            let a = if s.direction == StairDirection::East {
                0
            } else {
                1
            };
            b.lo[a] = f.lo[a] + f64::from(n) * going;
            b.hi[a] = b.lo[a] + going;
            b.hi[2] = b.lo[2] + f64::from(n + 1) * rise;
            out.push((b, "A-STAIR"));
        }
    }
    let last = p.levels.last().unwrap();
    let roof = last.elevation + last.height - p.slab_thickness;
    out.push((
        Box3::new(-c, -c, roof, w + c, d + c, roof + p.roof_thickness),
        "A-3D-ROOF",
    ));
    out
}
fn line(a: [f64; 2], b: [f64; 2], layer: &str) -> Value {
    json!({"type":"Line","layer":layer,"start":a,"end":b})
}
fn rect(x0: f64, y0: f64, x1: f64, y1: f64, layer: &str) -> Value {
    json!({"type":"LwPolyline","layer":layer,"vertices":[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],"closed":true})
}
fn text(value: impl AsRef<str>, x: f64, y: f64) -> Value {
    json!({"type":"Text","layer":"A-ANNO","value":value.as_ref(),"position":[x,y],"height":180.})
}
fn run(cmd: impl Into<String>) -> Value {
    json!({"op":"run","cmd":cmd.into()})
}
fn dim(a: [f64; 2], b: [f64; 2], at: [f64; 2]) -> Value {
    run(format!(
        "DIMLINEAR {},{} {},{} {},{}",
        a[0], a[1], b[0], b[1], at[0], at[1]
    ))
}
fn append(phases: &mut Vec<Phase>, name: &str, entities: Vec<Value>, commands: Vec<Value>) {
    let mut steps = vec![];
    for chunk in entities.chunks(200) {
        steps.push(json!({"op":"entities_create","entities":chunk}));
    }
    steps.extend(commands);
    for (i, chunk) in steps.chunks(61).enumerate() {
        let mut batch = vec![
            run("UCS WORLD"),
            json!({"op":"sysvar","set":{"CLAYER":"A-DIMS","OSMODE":0}}),
        ];
        batch.extend_from_slice(chunk);
        phases.push(Phase {
            name: format!("{name} / batch {}", i + 1),
            steps: batch,
        });
    }
}
fn cut_marker(e: &mut Vec<Value>, a: [f64; 2], b: [f64; 2], label: &str) {
    e.push(line(a, b, "A-ANNO"));
    for v in [a, b] {
        e.push(line(v, [v[0] + 250., v[1] - 350.], "A-ANNO"));
        e.push(line(v, [v[0] - 250., v[1] - 350.], "A-ANNO"));
        e.push(text(label, v[0] + 300., v[1] + 350.));
    }
}
fn derived_views(p: &MasterArchitecturalPlan, phases: &mut Vec<Phase>) {
    let (w, d) = dimensions(p);
    let c = p.column_size / 2.;
    let last = p.levels.last().unwrap();
    let roof = last.elevation + last.height - p.slab_thickness;
    let top = roof + p.roof_thickness;
    let mut marks = vec![];
    for l in 0..p.levels.len() {
        let dx = (l as f64 + 1.) * (w + 4000.);
        cut_marker(
            &mut marks,
            [dx - 500., 5150.],
            [dx + w + 500., 5150.],
            "A-A",
        );
        // B-B looks west, with horizontal direction arrows rather than the A-A north arrows.
        marks.push(line([dx + 4000., -500.], [dx + 4000., d + 500.], "A-ANNO"));
        for y in [-500., d + 500.] {
            marks.push(line([dx + 4000., y], [dx + 4350., y + 250.], "A-ANNO"));
            marks.push(line([dx + 4000., y], [dx + 4350., y - 250.], "A-ANNO"));
            marks.push(text("B-B", dx + 4450., y));
        }
        marks.push(text(
            "SCHEMATIC mm | 300 columns architectural only",
            dx,
            -3100.,
        ));
        marks.push(text(
            "Room polygons / furniture boxes are diagrammatic",
            dx,
            -3500.,
        ));
    }
    append(phases, "6 plan cut references", marks, vec![]);
    let (ox, oy) = (70000., 0.);
    let mut e = vec![rect(ox - c, oy - c, ox + w + c, oy + d + c, "A-3D-ROOF")];
    for (i, &x) in p.grid.x.iter().enumerate() {
        e.push(line([ox + x, oy - 600.], [ox + x, oy + d + 600.], "A-GRID"));
        e.push(text(format!("{}", i + 1), ox + x, oy - 950.));
    }
    for (i, &y) in p.grid.y.iter().enumerate() {
        e.push(line([ox - 600., oy + y], [ox + w + 600., oy + y], "A-GRID"));
        e.push(text(
            char::from(b'A' + i as u8).to_string(),
            ox - 1200.,
            oy + y,
        ));
    }
    e.push(text(
        "ROOF PLAN - FLAT SLAB / NO ROOF ACCESS",
        ox,
        oy + d + 1200.,
    ));
    e.push(text(
        format!("Slab top +{top:.0}; thickness {:.0} mm", p.roof_thickness),
        ox + 1000.,
        oy + 8500.,
    ));
    e.push(text(
        "No parapet, drainage, railings or roof stair designed",
        ox + 500.,
        oy + 7800.,
    ));
    e.push(text(
        "Not an accessible terrace; no invented balcony",
        ox + 500.,
        oy + 7300.,
    ));
    append(
        phases,
        "7 roof plan",
        e,
        vec![
            dim([ox, oy], [ox + w, oy], [ox + w / 2., oy - 1700.]),
            dim(
                [ox + w, oy],
                [ox + w, oy + d],
                [ox + w + 1800., oy + d / 2.],
            ),
            dim([ox - c, oy], [ox + w + c, oy], [ox + w / 2., oy - 2400.]),
        ],
    );
    for (index, (side, label)) in [
        (Side::South, "SOUTH / FRONT"),
        (Side::East, "EAST / RIGHT"),
        (Side::North, "NORTH / REAR"),
        (Side::West, "WEST / LEFT"),
    ]
    .into_iter()
    .enumerate()
    {
        let ox = index as f64 * 22000.;
        let oy = -24000.;
        let extent = if matches!(side, Side::South | Side::North) {
            w
        } else {
            d
        };
        let axes = if matches!(side, Side::South | Side::North) {
            &p.grid.x
        } else {
            &p.grid.y
        };
        let project = |u: f64| {
            if matches!(side, Side::North | Side::West) {
                extent - u
            } else {
                u
            }
        };
        let mut e = vec![text(
            format!("{label} ELEVATION - ORTHOGRAPHIC SCHEMATIC"),
            ox,
            oy + top + 1200.,
        )];
        for level in &p.levels {
            let z = level.elevation;
            let walltop = z + level.height - p.slab_thickness;
            e.push(rect(
                ox - c,
                oy + z - p.slab_thickness,
                ox + extent + c,
                oy + z,
                "A-3D-SLAB",
            ));
            e.push(rect(ox, oy + z, ox + extent, oy + walltop, "A-WALL-EXTR"));
            for &u in axes {
                let u = project(u);
                e.push(rect(ox + u - c, oy + z, ox + u + c, oy + walltop, "A-COLS"));
            }
            e.push(text(
                format!("FFL +{z:.0}"),
                ox + extent + 600.,
                oy + z + 100.,
            ));
        }
        for o in &p.openings {
            if o.side != side {
                continue;
            }
            let (axis, coord, a, b) = opening_bounds(p, o);
            if !(if axis == 0 {
                coord == 0. || coord == d
            } else {
                coord == 0. || coord == w
            }) {
                continue;
            }
            let level = &p.levels[room(p, &o.room).level];
            let a = project(a);
            let b = project(b);
            let bottom = oy + level.elevation + o.sill;
            e.push(rect(
                ox + a.min(b),
                bottom,
                ox + a.max(b),
                bottom + o.height,
                if o.kind == OpeningKind::Door {
                    "A-DOOR"
                } else {
                    "A-GLAZ"
                },
            ));
        }
        e.push(rect(
            ox - c,
            oy + roof,
            ox + extent + c,
            oy + top,
            "A-3D-ROOF",
        ));
        e.push(line(
            [ox - 1000., oy - p.slab_thickness],
            [ox + extent + 1000., oy - p.slab_thickness],
            "A-ANNO",
        ));
        e.push(text(
            format!("Roof +{top:.0} | openings are actual wall voids"),
            ox,
            oy - 1100.,
        ));
        let mut dims = vec![
            dim([ox, oy], [ox + extent, oy], [ox + extent / 2., oy - 1800.]),
            dim([ox, oy], [ox, oy + top], [ox - 2200., oy + top / 2.]),
        ];
        for level in &p.levels {
            dims.push(dim(
                [ox, oy + level.elevation],
                [ox, oy + level.elevation + level.height],
                [ox - 1300., oy + level.elevation + level.height / 2.],
            ));
        }
        append(phases, &format!("8 elevation {label}"), e, dims);
    }
    let boxes = model_boxes(p);
    for (label, axis, cut, ox) in [("A-A", 1, 5150., 0.), ("B-B", 0, 4000., 26000.)] {
        let oy = -46000.;
        let extent = if axis == 1 { w } else { d };
        let along = 1 - axis;
        let mut e = vec![text(
            format!("SECTION {label} - ORTHOGRAPHIC SCHEMATIC CUT"),
            ox,
            oy + top + 1300.,
        )];
        for (b, layer) in &boxes {
            if cut > b.lo[axis] && cut < b.hi[axis] {
                e.push(rect(
                    ox + b.lo[along],
                    oy + b.lo[2],
                    ox + b.hi[along],
                    oy + b.hi[2],
                    layer,
                ));
            }
        }
        for l in &p.levels {
            e.push(line(
                [ox - 650., oy + l.elevation],
                [ox + extent + 650., oy + l.elevation],
                "A-GRID",
            ));
            e.push(text(
                format!("FFL +{:.0}", l.elevation),
                ox + extent + 700.,
                oy + l.elevation + 100.,
            ));
        }
        e.push(text(
            if axis == 1 {
                "Cut y=5150, looking NORTH; intersects stair F1-F2"
            } else {
                "Cut x=4000, looking WEST; transverse cuts all 3 flights"
            },
            ox,
            oy - 1000.,
        ));
        e.push(text(
            "Cut geometry only; no beyond-cut projection or structure design",
            ox,
            oy - 1450.,
        ));
        e.push(text(
            "Stair 21R x170; 20G x260; landings 1000; width 1000",
            ox,
            oy - 1900.,
        ));
        e.push(text(
            "No railings / MEP / foundations; furniture 2D only",
            ox,
            oy - 2350.,
        ));
        let mut dims = vec![
            dim([ox, oy], [ox + extent, oy], [ox + extent / 2., oy - 3200.]),
            dim([ox, oy], [ox, oy + top], [ox - 2400., oy + top / 2.]),
        ];
        for l in &p.levels {
            dims.push(dim(
                [ox, oy + l.elevation],
                [ox, oy + l.elevation + l.height],
                [ox - 1300., oy + l.elevation + l.height / 2.],
            ));
        }
        append(phases, &format!("9 section {label}"), e, dims);
    }
}
fn check(p: &MasterArchitecturalPlan, phases: &[Phase]) -> Result<()> {
    spatial::validate(p)?;
    ensure!(
        p.levels.len() == 4 && dimensions(p) == (10000., 15000.),
        "wrong storeys or footprint"
    );
    for stack in ["KITCHEN", "SANITARY"] {
        let r: Vec<_> = p
            .rooms
            .iter()
            .filter(|r| r.wet_stack.as_deref() == Some(stack))
            .collect();
        ensure!(
            r.len() == 4 && r.iter().map(|r| r.level).collect::<BTreeSet<_>>().len() == 4,
            "incomplete wet stack"
        );
        ensure!(
            r.iter().all(|item| item.rect == r[0].rect),
            "misaligned wet stack"
        );
    }
    ensure!(p.stairs.len() == 3, "missing inter-storey stair");
    for s in &p.stairs {
        let l = room(p, &s.lower_room).level;
        let h = (p.levels[l + 1].elevation - p.levels[l].elevation) / f64::from(s.risers);
        ensure!(
            s.risers == 21 && h == 170. && 600. - 2. * h == 260.,
            "stair geometry"
        );
    }
    for phase in phases {
        ensure!(
            !phase.steps.is_empty() && phase.steps.len() <= 64,
            "invalid phase batch length"
        );
        for (i, s) in phase.steps.iter().enumerate() {
            for key in ["revision", "document", "document_id", "request_id"] {
                ensure!(s.get(key).is_none(), "caller-owned envelope field");
            }
            if let Some(b) = s.get("bindings").and_then(Value::as_object) {
                for binding in b.values() {
                    let src = binding["step"].as_u64().context("invalid binding")? as usize;
                    ensure!(src < i, "cross-batch or forward binding");
                    ensure!(binding["path"].as_str().is_some(), "missing binding path");
                }
            }
        }
    }
    // Negative controls exercise the real solver, including its access-graph check.
    let mut invalid = p.clone();
    invalid.openings.retain(|o| o.kind != OpeningKind::Door);
    ensure!(
        spatial::validate(&invalid).is_err(),
        "disconnected plan accepted"
    );
    let mut invalid = p.clone();
    invalid
        .rooms
        .iter_mut()
        .find(|r| r.id == "L4_wc")
        .unwrap()
        .wet_stack = Some("MISALIGNED".into());
    ensure!(
        spatial::validate(&invalid).is_err(),
        "invalid wet stack accepted"
    );
    Ok(())
}
fn main() -> Result<()> {
    let out = PathBuf::from(
        env::args_os()
            .nth(1)
            .context("usage: four_storey <outputdir>")?,
    );
    fs::create_dir_all(&out)?;
    let p = house();
    spatial::validate(&p).context("four-storey solver validation")?;
    let mut phases = spatial::compile(&p).context("compile real architectural CAD operations")?;
    let compiler_phases = phases.len();
    derived_views(&p, &mut phases);
    check(&p, &phases)?;
    fs::write(out.join("plan.json"), serde_json::to_vec_pretty(&p)?)?;
    fs::write(out.join("phases.json"), serde_json::to_vec_pretty(&phases)?)?;
    let mut views: Vec<Value> = (0..4)
        .map(|l| {
            let dx = (l as f64 + 1.) * 14000.;
            json!({"name":format!("floor-{}",l+1),"bounds":[dx-2000.,-4000.,dx+12000.,17500.]})
        })
        .collect();
    views.push(json!({"name":"roof-plan","bounds":[68000.,-3000.,83500.,17500.]}));
    for (i, name) in [
        "elevation-south",
        "elevation-east",
        "elevation-north",
        "elevation-west",
    ]
    .iter()
    .enumerate()
    {
        let x = i as f64 * 22000.;
        let width = if i % 2 == 0 { 10000. } else { 15000. };
        views.push(json!({"name":name,"bounds":[x-3000.,-27000.,x+width+5000.,-7500.]}));
    }
    views.push(json!({"name":"section-A-A","bounds":[-3200.,-50000.,15500.,-30000.]}));
    views.push(json!({"name":"section-B-B","bounds":[22800.,-50000.,47000.,-30000.]}));
    ensure!(views.len() == 11, "expected eleven drawing views");
    fs::write(out.join("views.json"), serde_json::to_vec_pretty(&views)?)?;
    let steps: usize = phases.iter().map(|p| p.steps.len()).sum();
    let entities: usize = phases
        .iter()
        .flat_map(|p| &p.steps)
        .filter_map(|s| s.get("entities").and_then(Value::as_array))
        .map(Vec::len)
        .sum();
    println!("VALIDATED: 4 levels; 10000 x 15000 mm centreline footprint; 3570 mm storeys; 2 wet stacks aligned on all levels");
    println!("{} rooms; {} actual openings; {} supported furniture instances; 3 stairs, each 21R170 / 20G260 / two 1000 landings",p.rooms.len(),p.openings.len(),p.furniture.len());
    println!("{} compiler batches + {} derived-view batches = {} phases; {} steps; {} submitted entities (profiles/block sources included)",compiler_phases,phases.len()-compiler_phases,phases.len(),steps,entities);
    println!("Validated door graph, stair geometry, wet-stack alignment, clearance/collision solver, <=64 steps, local bindings and rejection controls.");
    println!("4 floor plans + flat roof plan + 4 orthographic elevations + 2 real-solid-derived cut sections + genuine compiled 3D commands.");
    println!("LIMITS: schematic architecture, not structural/code certification; no accessible terrace, balconies, drainage or railings; furniture is 2D; sections show cuts only.");
    println!(
        "Files: {} ; {}",
        out.join("plan.json").display(),
        out.join("phases.json").display()
    );
    Ok(())
}
