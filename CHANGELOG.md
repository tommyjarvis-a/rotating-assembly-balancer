# Changelog

## 0.2.0-alpha.3 — 2026-11-24 (alpha)

Slice 2: the counterweight generator and the axial band. Static balance only; no export of the piece yet (slice 3).
- **Axial band** (section 2c): *auto* = the hub's axial extent next to the drive pin (hub geometry within ±30° of the
  pin angle; the hub's full axial extent without a pin), *planar face + thickness* (pick a face square to the axis;
  the sign of the thickness picks the side), or *typed start / end* (mm along the axis from the axis point). Shown as
  translucent slab planes in the view and passed to `correctionTarget({ constraints: { axialBand } })`.
- **Generator** (worker with progress and Cancel): voxelizes the allowed region (inside the Boundary, outside the
  Hub, inside the band) at an adjustable cell size (default from the boundary size, 1-2-5 steps; a 2.5M-node guard
  raises it with a note), then grows ONE 6-connected piece from the best allowed cell next to the hub, always adding
  the frontier cell with the largest lever along the needed-correction direction (bridges cost mass), and refines at
  the margin (add / remove a removable cell, keeping hub contact and connectivity) until the leftover is under the
  tolerance — this also removes the angle error. Default tolerance: the check-mode tolerance (g·mm, or G grade at the
  RPM for the hub mass), else 0.2 % of the needed correction.
- **Surface**: marching tetrahedra (consistent 6-tet split, closed and manifold), vertices placed exactly on the hub
  surface, boundary surface or band planes where the piece meets them; light Taubin (λ/μ, volume-preserving)
  smoothing of the free vertices only, with any vertex that would leave the region put back. Exact mass properties
  from the final mesh with the added material; if the leftover after meshing is over tolerance the voxel target is
  corrected and the piece re-meshed (up to 8 iterations; the count is shown).
- **Readout**: mass, volume, CG, m·r and angle, angle from the pin, leftover hub + load + piece with PASS / FAIL, cell
  count, iterations, triangles, pieces, closure, hub contact (or the gap), vertices outside the boundary / inside the
  hub / outside the band, and the facet-chord dip at concave boundary corners. The piece is shown magenta, counts as
  a Counterweight in check mode (and *Check containment*), and gets a row in the NX body table. *Remove generated*
  deletes it; changing any input marks it stale.
- **Sessions** store the generated mesh (base64, ≤ 8 MB; larger pieces are noted as "regenerate"), the band and the
  generator settings; earlier sessions still load.
- **Hardening (as alpha.2)**: every restored generator field is schema-checked (`cleanBand`, `cleanGenSettings`,
  `cleanGenMeta` in `src/session-schema.js`): band mode allowlist, finite face point / non-zero normal, numeric
  thickness / start / end; cell 1e-4–1e4 mm and tolerance > 0; the stored summary keeps only known numeric / vector
  fields, ≤ 10 notes of ≤ 300 chars and the input key. The generated mesh must be valid base64 under the size cap,
  decode to whole finite vertices (|x| ≤ 1e7 mm) and in-range triangle indices, with a checked density; its name must
  match `Generated CW [n]` and its material a preset id. Anything else is dropped and counted in a session card (a bad
  mesh becomes "regenerate"). All data text in the readout is escaped; the worker loads from 'self' and no inline
  scripts or styles are added, so the alpha.2 CSP is unchanged.
- Tests: 81 Node tests (79 pass, 2 optional OCP checks skipped), new: synthetic hub + boundary ring (leftover under
  tolerance, one closed piece touching the hub, inside boundary and band, opposite the needed angle, mass within 15 %
  of the lightest annular sector), tilted axis + typed band, Cancel and error cases, cell guard, column / segment
  helpers, band modes and session round trip, generated-mesh session packing and default tolerance, schema checks on every generator session field (incl. the
  malicious-session fixture, which now also carries generator payloads); `tools/ui-smoke-021.cjs` (Playwright, 24
  checks) and one more check in `tools/ui-smoke-020a2.cjs` (now 19: the malicious generator fields are rejected and
  shown as text, no script runs, no CSP violation).

## 0.2.0-alpha.2 — 2026-11-24 (alpha)

Fix release for the c8cc29d (alpha.1) gate. The counterweight generator moves to 0.2.0-alpha.3.
- **H4 — session files can no longer run script.** Every restored field is schema-checked (`src/session-schema.js`):
  body `rho` (finite, 0–1e5 kg/m³), `src` (allowlist), `on` (boolean), `mat` (preset ids), `role` (string, then
  the role rules); tools are rebuilt from checked fields only (known kind, name ≤ 80 chars, role allowlist, finite
  numbers, `free` bounds as finite pairs on known parameters, prism `pts` as ≤ 2000 finite pairs); pin radius and the
  assembly CG must be finite numbers. Rejected fields are dropped (current values or defaults stay) and counted in a
  session card. The sinks the gate found (`src`, ρ, free bounds, prism points, tool kind) are escaped, and a strict
  Content-Security-Policy meta is added (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  style-src 'self'`; no `unsafe-inline` / `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`).
  This was in every version since 0.1.0.
- **M7** — an orbiting-load body that becomes Hub or Boundary (or is gone) clears the load (status line says so), so
  the maths always matches the selector; `balanceState` also ignores such a load.
- **M8** — a picked drive pin stays geometry (axis point + direction): the e / ∠ boxes and the pin message are refreshed
  on every update, so they follow axis changes. Editing e or ∠ of a picked pin moves the pin about the spin axis
  (an unchanged box keeps the current value; the tilt is kept) instead of turning it into a typed pin with a stale e.
- **M9** — the containment edge-crossing test uses the same touching tolerance: a crossing needs the edge's ends on
  opposite sides of a boundary triangle by more than the tolerance. A counterweight whose OD sits on a curved bore
  (or is proud by less than the tolerance) is now inside; genuine crossings through a concave boundary are still caught.
- **L8** — a G-grade tolerance without an RPM says "enter an RPM to grade against G…".
- **L9** — files declaring a modelling uncertainty δ ≥ 0.01 mm floor every per-body ± at 0.01·δ/mm relative volume and
  0.2·δ CG (1e-3 and 20 µm at δ = 0.1 mm, covering the 9e-4 / 16 µm seen on the NX test file vs OCP) and mark it "≥".
- **L10** — no "-0.0000" in the body table.
- **L11** — the panel width follows the window (clamp 360–600 px, 34 vw; drag its edge to widen), and Role and Material
  share one column in the body list, so it fits at 470 px and an 800 px window keeps a 440 px view.
- Tests: 73 Node tests (71 pass, 2 optional OCP checks skipped), new `test/fixes020a2.test.mjs` (schema incl. the
  malicious-session fixture `test/fixtures/malicious-session.json`, picked-pin geometry, touching containment on a
  curved bore plus a real concave crossing, CAD floor); `tools/ui-smoke-020a2.cjs` (Playwright, 18 checks: CSP with
  import / WASM / workers, malicious session, M7, M8, L8, L10, L11, no CSP violations).

## 0.2.0-alpha.1 — 2026-11-24 (alpha)

Slice 1 of the counterweight generator: set-up, static readout and check mode. No material is generated yet.
- **Body roles**: Hub (exactly one), Boundary (exactly one, not a union), Counterweight (existing; one or more) and
  Ignore, with list badges / row markers and 3-D looks (hub teal, boundary see-through ghost that does not block
  picks, counterweight orange, ignore faded). Picking a new Hub or Boundary clears the old one. No keep-out role in
  v0.2.0. Boundary and Ignore bodies are left out of the section-2 residuals.
- **Materials**: Steel 7.85 and tungsten heavy alloy 17.0 / 17.6 / 18.0 / 18.5 g/cc presets per body, custom density;
  *Added material* (defaults to the hub's, stored for slice 2).
- **Spin axis as point + vector**, reusing the 0.1.x axis tools (typed point / direction with the M2 commit rule,
  cylinder, circular edge, two points, presets) plus a planar-face normal, a point picked on the model and a point
  snapped to the CG of the selection. Cylinder fits fall back to a mesh-region fit without B-rep face ids. The axis
  is drawn as a rod through the model with an arrow and a point marker.
- **Static readout**: hub |U| g·mm and angle (frame and zero reference shown), CG offset = perpendicular distance
  from the CG to the axis line, optional RPM → ISO 1940 G (achieved, nearest, finest met).
- **Drive pin** pick (cylinder-axis fit; > 0.5° off parallel warns and is projected parallel), orbit radius e and
  angle, typed fallback. **Orbiting load** at the pin from a body (Ignore allowed) or a typed mass; readout shows hub,
  load, total and the needed counterweight vector.
- **Check mode**: counterweight contribution, residual, % corrected, ISO grade of the residual, PASS / FAIL against a
  g·mm or G-grade tolerance, counterweight angle from the pin, over / under ratio with colour, separate angle-error
  flag, and a containment check in a worker with Cancel (ray-parity point-in-mesh, majority of X/Y/Z rays with a
  top-left tie rule for edge hits, plus an edge-crossing test); outside vertices are marked red.
- **Solver API hook** for slices 2+: `correctionTarget({ parts, points, axis, planes, constraints: { axialBand } })`.
- **Mesh accuracy (held fix from the NX STEP diagnosis)**: per-body mesh budgets (each body's deflection from its own
  size; only bodies over the per-body budget are coarsened; STEP subsets per mesh group), a calibration probe for the
  triangle prediction, honest uncertainty (max of the Richardson and pass-to-pass change; coarsened bodies flagged
  "≥"), an info card for a loose declared modelling uncertainty, and body names from `MANIFOLD_SOLID_BREP`
  (else "Body n"). The import worker and its Cancel button are unchanged.
- **Body table** for NX Measure Bodies (volume 0.001 mm³, CG 0.0001 mm from the model origin, density g/cc, mesh ±)
  with *Copy table* (TSV with header).
- Sessions save roles, materials, the added material, pin, load, RPM and tolerance; 0.1.x sessions still load.
- Faceted STEP (FACETED_BREP with planar FACE_SURFACE + POLY_LOOP) re-imports exactly (new fixture), for the slice-3
  export. A FACE (not FACE_SURFACE) with POLY_LOOP imports no body, and AP242 TESSELLATED_SOLID does not read in the
  vendored occt-import-js.
- Tests: 66 Node tests (64 pass, 2 optional OCP checks skipped) incl. roles, materials, line distance, direction
  normalisation, static imbalance, ISO grades, cylinder fit, pin e / angle, orbiting load, check mode, containment,
  per-body budgets, names and sessions; `tools/ui-smoke-020.cjs` (Playwright, 36 checks).


## 0.1.8-alpha — 2026-11-13

- **Fix (High, H3):** a session exported while the assembly CG was stale no longer restores that CG as current.
  A restored CG is current only if the saved CG was not stale *and* every saved body matches exactly with the
  same body count. A missing `stale` flag in an older session is treated as stale. In every other case the
  numbers are kept but marked stale, or dropped, and a notice is shown. `touchCG` / load completion still cannot
  clear the flag; only a successful *Calculate CG* does.
- Export writes `assemblyCG.stale` (and the CSV stale row) from the live flag, including after a density,
  selection or body-set change made after *Calculate CG*. Re-export after restore round-trips the flag.
- An extra hole found in the restore sweep: a same-count body-set change (for example a `REMOVE_` twin in
  place of a positive body) could previously look like an exact match because the CG subset still mapped and
  the counts were equal. The whole session body list must now match for the CG to be current.
- Tests: generated 48-case restore/stale matrix (saved current / stale / legacy × same or other file × body
  count changed or not × `REMOVE_` twin or not × density edit or not), plus the Tester case D repro and
  truthful-export checks (48 Node tests incl. the optional OCP check). `tools/ui-smoke.cjs` covers a headed
  subset: current same-file restore, stale-after-density restore, a legacy session with no flag, and an
  other-file drop.


## 0.1.7-alpha — 2026-11-13

- **Fix (High, H2):** finishing a file load no longer clears a stale assembly-CG flag. `touchCG()` can only *set*
  stale (via `holdStale`); only a successful *Calculate CG* clears it. A session restore keeps the saved CG
  numbers only on an exact full match of every saved body (and the same body count). Anything else drops the
  values and the marker, leaves the result stale, keeps any partial selection, and shows a notice — so a CG
  saved from a different file cannot appear as current.
- **Fix (Medium, M6):** session matching treats `REMOVE_*` status (the mass sign) as a hard key, so a body is
  never paired with its removal counterpart even when the volume and bbox are identical. The base name (without
  a ` #n` suffix) is also a hard key when it is unique on both sides; the volume + bbox fingerprint only decides
  among same-name, same-sign candidates. A changed body count leaves unmatched bodies untouched and the CG
  dropped/stale, with a notice.
- Tests: mismatched restore + load completion stays stale; a cross-file session drops the CG; a `REMOVE_` twin
  is not matched; add/remove a body leaves the CG stale; a unique base name blocks a fingerprint match to a
  different name (45 Node tests incl. the optional OCP check).


## 0.1.6-alpha — 2026-11-13

- **Fix (Medium, M3):** the gold assembly-CG marker, the RGB origin arrows and the dashed origin-to-CG line
  were hidden by the (transparent) body meshes; only the DOM labels showed through. They now render in an
  overlay pass after a depth clear (`depthTest`/`depthWrite` off, `transparent`, high `renderOrder`), so they
  stay a constant size on screen and draw on top of the parts.
- **Fix (Medium, M4):** session restore no longer matches bodies by name alone. Densities, on/off flags and the
  saved assembly-CG selection are keyed by body index plus a volume + bbox fingerprint (relative tolerance
  1e-3); the name is only a hint when fingerprints collide. If a body is ambiguous or does not match, it is
  left untouched, the CG is marked stale, and a notice is shown. 0.1.x sessions with unique names still load.
- **L7:** duplicate display names (e.g. a single-product NX file whose solids all inherit the file name) are
  numbered `name #1`…`#n`. Unique names are unchanged. The same names are used in the list, exports and session.
- Tests: unique-name suffixes; fingerprint match with duplicate names, a reordered set, a mismatch, identical
  twins and a legacy name-only session (40 Node tests incl. the optional OCP check); `tools/ui-smoke.cjs`
  checks the overlay material flags and that gold / RGB marker pixels are visible.


## 0.1.5-alpha — 2026-11-13

- **Assembly CG**: *Calculate CG* next to the body list computes the mass-weighted combined centre of gravity of
  the bodies currently selected on the left (each body's density and mass; `REMOVE_*` bodies count as negative
  mass). Multi-select: Ctrl/⌘-click to add or remove a body, Shift-click a range (click still selects one;
  Esc / empty space clears). The readout shows X, Y, Z in mm from the WCS origin (0, 0, 0), the total mass (g)
  and how many bodies were included. A gold sphere + crosshair with a constant-size "CG" label (drawn through
  geometry) marks the point in the 3-D view, distinct from the red residual CoM ball. The readout still works
  when WebGL is unavailable.
  - No bodies selected, or net mass zero/negative: an inline message, no marker.
  - **Stale handling:** the result and marker stay visible after a calculation. If the selection, a density, or
    the body set then changes, both are marked stale until *Calculate CG* is clicked again (they are not
    recalculated automatically).
  - The result is written to the JSON (`assemblyCG`) and CSV exports and restored from a session (selection is
    recovered by body name; the result is marked stale if the current bodies do not match).
- **Model-space origin** at (0, 0, 0): small X/Y/Z axes in red/green/blue with a constant-size "Origin 0,0,0"
  label, drawn through geometry. Separate from the lower-left WCS triad and from the gold assembly-CG marker.
  A dashed line is drawn from the origin to the CG while a CG result is shown.
- Tests: combined CoM vs closed form and OpenCascade `BRepGProp` on fixture `cg-assembly.stp` (includes a
  `REMOVE_*` body and a subset selection) (33 Node tests incl. the optional OCP check); `tools/ui-smoke.cjs`
  covers Calculate CG, the marker, the no-selection message, stale handling, the origin marker, and JSON/CSV/session.


## 0.1.4-alpha — 2026-11-13

- **Fix (Medium, M2):** typing the spin-axis direction one field at a time no longer changes the axis.
  Previously every change on the direction boxes normalised the (still incomplete) vector and wrote all three
  fields back, so a unit vector entered as 0.40558, −0.40558, 0.81915 became (0.36047, −0.38899, 0.84779),
  4.3° off, and residuals were wrong (|U| 274.6 instead of 108 on the QA tilted two-body case). The boxes now
  keep the values as typed; the direction is normalised only internally (on change, blur or Enter, and before
  computing). A zero or non-numeric entry shows an inline error and keeps the last valid axis. Presets, picks
  and session restore still fill the boxes. A read-only unit-vector readout is shown next to the fields.
  JSON/CSV axis output and session reload are unchanged.
- Tests: field-by-field QA repro (raw values kept, |U| ≈ 108 vs the previous 274.6) (29 Node tests incl. the
  optional OCP check); `tools/ui-smoke.cjs` covers the same path, the unit readout, and a non-numeric rejection.

## 0.1.3-alpha — 2026-11-13

- **User-defined spin axis**: point + direction, typed (normalised, zero rejected) or picked in the 3-D view from a
  cylindrical face (least-squares cylinder: normals' null space + circle fit), a circular edge loop (plane + circle
  fit) or two points; poor fits are rejected with a message. Presets (X/Y/Z, principal axis) set the same axis
  object. Residuals, two-plane readout and optimiser use it; u/v/w is derived deterministically; axial positions are
  measured along w from the axis point; new tools are placed on the axis. Drawn as line + arrow through the point.
  Point, direction, source and u/v/w are in the JSON/CSV export and the session (0.1.x sessions still load).
  Principal-axis directions now use the fixed sign rule (largest component positive), so u/v may flip vs 0.1.2.
- **WCS triad** (X/Y/Z red/green/blue, labelled) in a lower-left inset that follows the camera; crisp on HiDPI and
  after resize / zoom.
- **Body selection** synced between the list and the 3-D view (raycast), highlight, scroll-into-view, Esc / empty
  click deselects; orbit drags (> 5 px) are not clicks.
- **L5**: "mesh coarsened" / fast-fallback is a warning only if the estimated error matters (relative volume
  > 1e-4 or CoM > 1 µm for any body), otherwise a quiet info card. Fast mode gets a rough probe-based uncertainty.
- **L6**: ⚠ "unreliable" only when the mesh does not close — volume closure `|ΣA|·(D/2)/(3|V|)` > 1e-4 — or > 5 % of
  edges are open/non-manifold; isolated bad edges get a quiet ⓘ.
- Without WebGL the app keeps working (error card; no 3-D view) instead of failing to start.
- Tests: tilted-axis invariance, cylinder/loop fits and rejections, optimiser about a tilted axis, closure check,
  error-gated notes (28 Node tests incl. the optional OCP check); `tools/ui-smoke.cjs` headed UI smoke; both browser scripts
  can run installed Microsoft Edge (`BROWSERS=msedge`). Synthetic fixture `tilted-rotor.stp`.

## 0.1.2-alpha — 2026-11-13

- **Renamed** to **Rotating Assembly Balancer** (repo `rotating-assembly-balancer`; the old
  `compressor-balancer` Pages URL no longer serves the app). Description is generic, e-compressors are one example.
- **Fix (High): importing a STEP file froze the page and the tab crashed** on real-world parts (Edge/Chrome, also
  reproduced in WebKit). Root cause: accurate mode meshed every file twice, synchronously on the main thread, with
  fixed fine tessellation settings (bbox ratio 1e-4 / 2.5e-5, 0.02 / 0.01 rad). Filleted parts produced 1.5M–12M
  triangles and needed 100–600+ s and up to 2.6 GB (a 135 KB, 40-face shaft: 1.49M triangles / 106 s for pass 1).
  The 0.1.x fixtures have ≤ 20 simple faces, so tests and headless smoke runs never hit it.
  - Import, tessellation, density and mass properties now run in a module Web Worker (one per file, terminated
    afterwards to free the WASM heap; WASM compiled once). Progress, Cancel, 180 s timeout with an error card.
  - Tessellation budget: deflection relative to the bbox diagonal (clamped), triangle prediction from a probe pass,
    1.2M total / 600k per body; coarsens or falls back to fast mode with a warning card.
  - Faster closed-mesh check (numeric edge keys).
- Tests: clamp/budget/prediction, fast fallback, import-pipeline accuracy (21 Node tests + optional OCP);
  `tools/browser-smoke.cjs` Playwright responsiveness check for Chromium and WebKit.

## 0.1.1-alpha — 2026-11-13

Fixes from the 0.1.0-alpha release gate (QA GATE-69afba1).

- **M1:** a STEP density now applies only to the body whose product it belongs to. Previously, when a file
  carried density for some products only, every other body took that density (tagged *STEP*), giving wrong mass
  and residuals (QA repro: shaft 32.57 g instead of 94.70 g). A file-wide density is used only if no record
  matches any body and the file has a single value (tag *STEP (file)*); otherwise the default applies.
- **L1:** for spin axis X, Y or a principal axis, residuals are labelled u/v (frame components) with the world
  basis shown; JSON/CSV exports carry the component names and basis. Axis +Z keeps x/y.
- **L2:** editing a body's density updates its source tag to *user* immediately.
- **L3:** removal tools are flagged (`removal` in JSON/CSV) and `REMOVE_*` solids re-imported from STEP count as
  negative mass.
- Tests: QA partial-density repro, mixed-density fixture, frame labels, removal STEP round trip (17 + 1 optional).

## 0.1.0-alpha — 2026-11-13

- STEP (AP214/AP242) drag-and-drop import via occt-import-js 0.0.23 (WASM, lazy-loaded); three.js 0.187.0 viewer.
- Exact mesh mass properties (signed tetrahedra) with two-pass Richardson extrapolation and per-body uncertainty;
  open-mesh warning; density read from STEP when present, per-body override, material presets.
- Spin axis X/Y/Z or a body's principal axis; static imbalance U (g·mm), couple C (g·mm², ∫xz/∫yz dm), e (µm),
  equivalent two-plane residuals; CoM / axis / imbalance arrows in 3D.
- Parametric tools: annular sector, cylinder/tube, extruded polygon; add or remove material; closed-form mass properties.
- Nelder–Mead optimiser with box bounds (sin transform), deterministic multi-start, mass penalty.
- Export: session JSON, CSV, AP214 STEP of tools (validated by occt-import-js re-import and OpenCascade BRepCheck/BRepGProp).
