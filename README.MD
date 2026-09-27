# NFO/KEY → glTF converter

Converts this ~2004 game's proprietary `.NFO` (models) and `.KEY`
(skeletal animations) files into `.gltf` (+ `.bin`), ready to open in
Blender with UVs, materials, skeleton, and animation already linked up.

## Usage

```
pip install pygltflib numpy
```

Put the script files next to three folders (as in your setup):

```
convert_all.py
nfo_parser.py
key_parser.py
gltf_export.py
mathutil.py
chunkfmt.py
blender_organize.py
models/     *.NFO
keys/       *.KEY
textures/   *.PNG   (already-converted textures)
```

Then:

```
python convert_all.py
```

This writes `OUT/<ModelName>/<ModelName>.gltf` + `.bin` for every `.NFO`
in `models/`, with any `.KEY` files whose skeleton matches embedded as
animation clips (**all animations share the same armature/skin** — that's
what lets things like head/chest look-rotation work cleanly), and copies
any matched textures next to the output.

Useful flags:

- `--only SomeModel.NFO` — convert just one file (fast iteration).
- `--axis-mode z_up_to_y_up` — only if a model imports lying on its
  back/side (default `none` is correct for this engine — it's already
  +Y-up / -Z-forward, same as glTF).
- `--fps 25` — `.KEY` files store no explicit frame rate; default is 30.
- `--no-hitboxes` — skip the hitbox debug meshes. (`--no-hulls` still
  exists but is now a no-op with an explanatory message — see changelog
  round 2 for why hull export was removed entirely.)
- `--rotation-mode key_only` (default) — how KEY rotation combines with
  bind rotation during animation; `key_only` is the well-evidenced
  default now, see changelog round 4. `bind_then_key` /
  `key_conj_then_bind` are kept as an A/B fallback if a clip ever still
  looks wrong.
- `--scale 0.01` (default) — uniform factor applied to every exported
  position (vertices, hitboxes, bone translations, animation
  translations). Default converts the engine's centimeter-ish units to
  meters; pass `--scale 1.0` to keep raw units.

## After importing in Blender

Import the `.gltf` normally (File → Import → glTF 2.0). Then open the
Scripting tab, load `blender_organize.py`, and run it once. It sorts the
flat "everything under Armature" object list into real Collections:

```
Armature
LOD0
    lod0_torrente
    lod0_hat_amarillo / lod0_hat_rojo
    lod0_heridas (collection)
        lod0_Herida_Cabeza, ...
LOD1 / LOD2   (same shape)
Hitboxes
Collision
```

It also deletes the leftover `Meshes` empty if one is present (only
relevant for `.gltf` files exported before changelog round 5 — the
exporter no longer creates it at all). This LOD-collection sorting is a
separate post-import step rather than something baked into the `.gltf`
because Blender's importer always reparents any *skinned* mesh object
directly under the Armature object, regardless of where it sits in the
glTF node tree — there's no glTF-side trick that produces real Blender
Collections for skinned meshes, it has to happen after import.

(The little "Icosphere" object under a `glTF_not_exported` collection
that Blender creates is Blender's own default bone-display shape, not
something in the file — safe to ignore or delete.)

## Changelog — what changed from the first version, and why

You found real bugs by actually opening a file in Blender; here's what
each report traced back to and how it was fixed:

- **Output format**: now `.gltf` + `.bin` (readable/diffable text) instead
  of `.glb`.
- **Flipped faces**: triangle winding order was reversed to match glTF's
  front-face convention.
- **Twisted geometry / bones "messed up" in Object mode**: traced to mesh
  vertex data actually being stored in **whole-model bind space**, not
  bone-local space (confirmed by checking real bounding boxes — e.g. the
  head-cap mesh's own bbox sits at head height, not centered near zero).
  The first version rigidly parented "unweighted" meshes (caps, wound
  decals) under their bone node, which — given vertex data already in
  world space — applied that bone's transform a second time. Every mesh
  is now uniformly exported as a proper skin (even ones with only a
  single influencing bone), so nothing ever gets double-transformed.
- **Hat position wrong**: same root cause as above, same fix. Hats are
  now single-joint-skinned to the head bone with correct weights, so
  they also correctly follow head animation.
- **Stray empty objects**: the first version created a glTF node for
  every one of a mesh's "attachment" `TRA1` entries (name + bind
  transform) *and* a separate mesh node under it, so you'd see an empty
  plus a same-named mesh child (Blender's ".001" collision). Those
  attachment entries are now used purely as metadata (which bone a mesh
  belongs to) and never instantiated as glTF nodes.
- **LODs not organized into collections**: this turned out to be
  impossible to do purely from the glTF side (see the Blender-import
  section above for why) — solved with `blender_organize.py` instead.
- **"LOD0 is just an empty"**: was the `LOD{N}` glTF grouping node, which
  Blender's importer never nests skinned meshes under. It's been removed
  entirely from the export; `blender_organize.py` now builds the LOD
  grouping from object names instead.
- **`.001` name suffixes / `{NNNN}` in names**: the numeric LOD-distance
  infix (`lod1_0_`, `lod2_1500_`, ...) is now stripped from every
  exported name, e.g. `lod1_0_Herida_Cabeza` → `lod1_Herida_Cabeza`. The
  `lod{N}_` prefix is kept (and is what `blender_organize.py` sorts on),
  so names stay unique across LODs without Blender needing to append
  anything.
- **Missing hull / hitboxes**: hitboxes now exported (`BOX1`, 12 in
  your sample), shared across LODs (they only exist once in the file
  to begin with) and single-joint-skinned to their bone. The `STP1`
  "hull" data turned out not to be collision geometry at all — see
  changelog round 2 below — so it's not exported.
- **Missing "heridas" material / texture**: the file has no dedicated
  material or UV set for wound decals (confirmed — every byte of a
  mesh's geometry block is accounted for by position/UV/normal/face
  data, there's no second UV channel). A `heridas` material is now
  synthesized and assigned to every mesh whose name contains "Herida",
  looked up in `textures/` tolerant of the double extension
  (`heridas.tex.png` matches a lookup of `heridas`). As you suspected,
  actually mapping the decal onto the body's own UV space (rather than
  keeping it as a separate overlapping mesh) is a job for the Godot
  import step, not this converter — the source data doesn't hand us a
  ready-made UV island to do that with here.
- **Team-color hats as one object**: kept as two separate small mesh
  objects (`lod{N}_hat_amarillo` / `lod{N}_hat_rojo`) rather than merged
  into one, since that's what the source data actually contains (two
  distinct `MSH1` entries) and merging them into a single
  material-swappable object would mean throwing away/reconstructing
  data rather than converting it. Both are cheap (few hundred bytes);
  pick whichever you need at the Godot-import stage.

## What's exported

- **Meshes**: every `MSH1` in every LOD, named `lod{N}_<name>` from the
  model's own node names (`torrente`, `Mesh_Equipo_Amarillo/Rojo`,
  `Herida_*`).
- **UVs + normals**: read straight from the file's own per-corner index
  streams.
- **Materials**: one glTF material per `MTR1` skin (`una cara`,
  `Doble cara`, `Gorras_amarillas`, `zbias_torrente` in your sample),
  base color from diffuse RGBA, texture linked if found in `textures/`,
  plus a synthesized `heridas` material for wound decals.
- **Skeleton**: full 29-bone hierarchy, one glTF `Skin` shared by every
  mesh and every animation.
- **Skinning**: real per-vertex weights (`ZTR1` groups) where the source
  has them (e.g. the main body); single-joint 100%-weight skinning
  everywhere else (caps, decals, hitboxes) — see changelog above for why
  this matters.
- **Animations**: every compatible `.KEY` becomes a clip on the shared
  armature.
- **Hitboxes**: all 12, shared across LODs, skinned to their bone.

## Format notes (for your own reference / future files)

Every structural claim below was checked against real bytes, not just the
Ghidra decompile — see the docstrings at the top of `chunkfmt.py`,
`nfo_parser.py`, and `key_parser.py` for the full chunk trees and byte
layouts. Highlights:

- Container chunks are `tag(4 ASCII) + size(u32 LE)`, and **size includes
  its own 8-byte header** — the one thing that doesn't match ordinary
  RIFF/IFF chunks.
- A `MSH1`'s header carries an explicit **node index** (not implicit file
  order!) that's the authoritative link to its name and parent bone in the
  `TRA1` list.
- All mesh vertex data (and hitbox corners) are in **whole-model bind
  space**, not bone-local space.
- Bone **rest positions** are derived from mesh skin-weight centroids,
  not from the `TRA1` matrices directly — see changelog round 2. Bone
  rest *rotation* is identity for every bone (animation fully overrides
  it per frame anyway).
- `.KEY` per-bone-per-frame data is `[qx,qy,qz, px,py,pz, sx,sy,sz, qw]`
  (10 floats) — note `qw` is stored *last*, separated from `qx,qy,qz`.

## Remaining unverified / lower-confidence areas

1. **`.KEY` composition during animation playback** — resolved in
   changelog round 4 (`key_only`, full replacement); kept here as a
   pointer in case a different clip ever needs the A/B fallback modes.
2. **`BOX1` hitbox `flag` field** — byte layout is solid, meaning unknown.
3. **`.KEY` frame timing** — no explicit per-frame time in the file;
   frames are spaced evenly at `--fps`.
4. **The exact meaning of `STP1`** — confirmed NOT to be collision
   geometry (see changelog round 2); still unknown what it actually is
   (per-face material/footstep-surface data is my best guess, given it's
   tag-adjacent to the `SND2` sound-event markers found in `.KEY` files,
   but unverified).
5. **T-pose roll on fingers/toes** — the round 5 bind-rotation fix
   auto-derives roll from geometry per bone, but short/closely-spaced
   bones (fingers especially) give it a noisier signal to work from;
   your own manual correction file flagged the same bones as uncertain.
   If a specific finger looks twisted, it's the most likely place to
   spot-check first.
6. **KEY animation quaternions vs. the round 5 axis fix** — flagged in
   round 5's changelog: animated frames almost certainly need the same
   per-bone axis correction applied that bind pose just got, and that
   hasn't been done yet.

## Changelog round 2 — bone positioning/rotation, hull, multi-character

Your second round of testing found the deeper issue: bones (and anything
riding on them — hitboxes, the "hull") were still wrong, and it turned
out to be worse than a double-transform. Here's what actually happened
and what changed:

- **Root cause**: I spent a long time empirically testing every
  reasonable interpretation of the `TRA1` bone matrices — row-major vs
  column-major, transposed vs not, parent-first vs child-first
  composition, even treating them as inverse-bind matrices — computing
  full skeleton world positions each time and comparing against
  known-good anatomy. **None of them worked.** Finger bones ended up
  hundreds of units from the hand; the leg chain went the wrong
  direction. The *individual* per-bone translation values looked
  sensible in isolation, so the bug is specifically in how the rotation
  part of these matrices is meant to combine down the hierarchy — and
  without the actual engine source for that step (not present in what
  was decompiled), I can't pin down the exact convention.
- **The fix**: rather than keep guessing, I derived each bone's rest
  *position* directly from the mesh itself — specifically, the
  weighted centroid of whichever vertices are actually skinned to that
  bone (`ZTR1` groups), which is data I already know is correct because
  the mesh renders right. I verified this produces a clean, correct
  T-pose: spine running foot-to-head in a smooth line, legs running
  the right direction, arms extending sideways at a consistent height.
  25 of 29 bones have this data directly; the remaining 4 (the root
  anchor, a "footprints" reference bone, one dummy bone, and an
  "Orientador" helper) fall back to their parent's position, which is
  harmless for what they are.
- **What this fixes**: bone rest positions, and therefore hitbox
  positions too (hitboxes are skinned the same way meshes are, so they
  inherit the same fix) — both should now sit correctly against the
  mesh rather than being offset up/forward.
- **What this does NOT independently verify**: bone *rotation* during
  animation playback. `.KEY` files fully override translation,
  rotation, and scale every frame for every bone they cover, so the
  rest pose I just fixed only matters for (a) how the skeleton looks
  with no animation playing, and (b) the skin's inverse-bind matrices.
  Whether `.KEY`'s own per-frame values compose correctly through
  Blender's standard forward-kinematics is a separate question I
  haven't been able to independently confirm the same rigorous way
  (there's no equivalent "mesh ground truth" for an arbitrary animated
  pose). **Please check both**: does the T-pose/rest skeleton now look
  right, and separately, does playing the animation look right? If the
  rest pose is good but a clip still twists, that isolates the problem
  to `.KEY` composition specifically, which narrows things down a lot.
- **"Hull" removed**: re-examined `STP1` and you're right — it's not
  collision geometry, it duplicates the render mesh's own triangles
  1:1. Exporting it as a fake `collision_hull` was actively misleading,
  so it's gone. If your engine really has no stored hull data, that
  matches your own guess that it's generated by game logic at runtime.
- **Hitboxes**: still exported, now correctly positioned per the fix
  above. `hitbox_00` being unusually wide may just be a real, large
  volume in the data (e.g. a pickup/interaction trigger rather than a
  body-part hitbox) rather than a bug — worth a second look now that
  positioning is fixed, but I'd want to see it before guessing further.
- **Bone Collections not appearing in the Armature data tab**: that's
  normal, not a bug — Bone Collections are a Blender 4.0+ feature that
  replaced the older "Bone Layers," and glTF import doesn't populate
  them (glTF has no concept of bone grouping to import from). Nothing
  to fix here.
- **`blender_organize.py` now supports multiple characters**: it scans
  the whole scene for every Armature object, figures out which mesh
  objects actually belong to each one (via their Armature modifier), and
  organizes each into its own top-level collection — skipping any
  armature that's already alone in its own properly-organized
  collection. Run it once after importing any number of models into the
  same scene.

## Changelog round 3 — the actual bone rotation fix

You shared decompiled game code for the real per-frame bone update
functions (`vtActor::UpdateBones`, `SolveIK`, `CalculaEsqueleto`,
`CalculaBase`, etc.), and it broke the case open:

- **The real animation semantics**: the engine converts each frame's KEY
  quaternion into a rotation matrix and does
  `bone_local_matrix *= RotationMatrix(quat)` — meaning the KEY rotation
  is a **multiplicative delta composed onto the bind rotation**, not a
  full replacement. Translation, by contrast, *is* a full replacement
  (LERPed between keyframes, then written directly over the bind
  translation via `SetRow`). My previous version treated both as full
  replacements, which is only equivalent when the bind rotation is
  identity — which is exactly what I'd fallen back to, so the delta was
  silently getting applied on top of nothing.
- **The real bind rotation**: with that as a lead, I went back and
  re-tested the `TRA1` matrices with a different hypothesis — that each
  bone's rotation is already **absolute/world**, not parent-relative,
  matching the same pattern already found for mesh vertices and hitbox
  corners in this format. This checks out two ways: reconstructing a true
  parent-relative rotation as `inverse(R_parent) @ R_child` and recomposing
  it hierarchically reproduces the original exactly (expected, but a
  useful sanity check), and — the real test — that bone's own raw
  rotation matrix's local X axis (negated for the spine/leg chain,
  positive for the arm chain, a left/right mirroring convention) points
  toward its child, verified against the trusted mesh-centroid positions,
  for *every* bone including ones 7-8 levels deep in the hierarchy
  (`|dot| > 0.88` throughout, weakening only for a couple of very short
  finger bones where direction is inherently noisy). That's a strong,
  broad, independent confirmation — not a coincidence for one or two
  bones.
- **Combined fix**: bind translation still comes from mesh skin-weight
  centroids (round 2); bind rotation now comes from each bone's own TRA1
  matrix used directly as absolute/world, converted to a true
  parent-relative local rotation the same way; animation channels compose
  the KEY quaternion onto that bind rotation instead of replacing it.
- **Still an open question**: the exact quaternion composition *order*
  (`key * bind` vs `bind * key`) was derived algebraically from the
  decompiled code's row-vector semantics rather than independently
  re-verified the rigorous way the bind pose was (there's no equivalent
  "mesh ground truth" for an arbitrary mid-animation pose to check
  against). If a clip still looks subtly wrong — most likely a consistent
  mirroring or double-rotation rather than the wild divergence from
  before — that composition order is the first thing to flip and retest.
- **Hitboxes**: unchanged mechanically (still single-joint-skinned,
  corners still in whole-model space), but now inherit the corrected bind
  rotation from their bone automatically, which should resolve the
  90°-off appearance.

## Changelog round 4 — the doubled-rotation bug

Your reports (T-pose correct, animation twisted, hitboxes consistently
"looking to the right" only during playback) pointed at the KEY-compose
step specifically, not the bind pose. Checking the numbers directly
found the actual bug:

- For the root bone, KEY's own quaternion at frame 0 (and frame 5, and
  frame 10 — it's essentially constant) is **almost identical to the
  bind rotation itself**, both representing a 90° turn. Composing them
  (as round 3 did) gives 90°+90° = **180°** — a consistent whole-body
  extra rotation, which matches "looking to the right" and "twisted"
  exactly, and explains why it only showed up during animation (T-pose
  has no KEY rotation to compose with, so it was unaffected).
- Re-reading the decompiled code more carefully: there are two different
  bone-update functions, and I'd conflated them. `UpdateAnimBones` —
  the one that runs for normal single-clip playback, which is what's
  happening here — does a **straight copy**: `this->matrix[bone] =
  RotationMatrix(key_quat)`, full replacement, no bind composition.
  `UpdateBones`'s `*=` compose only runs when an IK/blend-chain pointer
  is active, i.e. for layering things like aim or head-look corrections
  on top of an already-set base pose — not the general case.
- **Fix**: rotation is back to a full replacement (`--rotation-mode
  key_only`, now the default) — position was never the issue, it was
  already a full replacement (LERPed, written directly) and stays that
  way. Bind rotation (round 3's validated absolute-per-bone extraction)
  still matters for the T-pose and for any bone a given `.KEY` doesn't
  cover, just no longer composed with animated bones.
- Also dropped the **scale** animation channel entirely (kept static at
  bind's 1,1,1): the decompiled rotation-matrix constructor only ever
  takes the quaternion (4 floats), never scale, so KEY's scale field
  isn't actually used by the engine for bone transforms — animating it
  was pure guesswork that could only hurt.
- The `--rotation-mode` flag (`bind_then_key`, `key_conj_then_bind`)
  stays available as an A/B fallback in case a different model or clip
  ever needs a blend-style compose, but `key_only` is the well-evidenced
  default now.

If bones still look wrong after this, it's likely a genuinely different
issue than what's been chased so far — at that point the most useful
thing you could share is which specific bone/frame looks wrong and in
which direction, since the whole-body "doubled rotation" pattern is
now understood and fixed.

## Changelog round 5 — T-pose bone tail orientation, `Meshes` empty, scale

Your report: T-pose bone *heads* (positions) were right, but *tails*
(the direction each bone points, i.e. its rotation as Blender displays
it) were wrong, and you supplied a hand-corrected reference skeleton
(`corrected_t-pose_bones.blend`) to check against.

- **Root cause**: round 3's bind-rotation extraction (each bone's own
  TRA1 matrix used directly as its absolute/world rotation) was actually
  correct as far as it went — that's exactly why positions/heads were
  fine. The bug is one level up: Blender (and glTF import in general)
  always treats a joint's local **+Y** axis as "bone direction" when
  turning a rotation into a visible edit-bone head/tail/roll. This
  engine's own convention for which axis is "forward" (points at the
  child bone) is **not** Y — checking against your corrected reference
  shows it's local **X** for almost every bone (spine, arms, legs), but
  local **Z** specifically for the foot bones. That's a per-bone-type
  authoring choice in the original content tool, not noise or a parsing
  bug — swapping the right axis into Y's slot lines it up.
- **Fix**: a new step, `_auto_correct_bind_rotations` in
  `nfo_parser.py`, runs after the existing absolute-rotation extraction.
  For each bone it auto-detects *which* local axis is "forward" from
  that bone's own real children's directions (using the trusted
  mesh-centroid positions from round 2/3, not the TRA1 matrix's own
  claims), then rebuilds an orthonormal frame with local Y pointed at
  the child and roll carried over from whichever of the engine's other
  two axes wasn't consumed. This is auto-detected per bone rather than
  hardcoded to "X" specifically, so it should hold up on your other
  character files too, not just this skeleton.
- **Validated against your correction file**: I read
  `corrected_t-pose_bones.blend` directly (a small pure-Python `.blend`
  parser, via the `blender-asset-tracer` package — no Blender install
  needed) and compared every bone's corrected orientation against what
  this fix now produces. Every major limb (pelvis, spine, both upper
  arms, both forearms, both thighs, both shins) is within **2°**;
  overall median across all 25 real bones is **~8.7°**. The bones with
  more residual error are exactly the ones you flagged as uncertain
  yourself — fingers (you said roll/Z there wasn't verified against
  geometry) and toes (checking the numbers, your reference file's toe
  bones are numerically identical to the *uncorrected* raw data, i.e.
  they don't look like they got a manual pass at all — worth a look if
  toe orientation matters for your use case).
- **Note for the animation round you mentioned next**: bind pose
  rotation just changed, but KEY's per-frame quaternions are still the
  *raw* engine values (round 4's `key_only` full-replacement, unchanged
  by this round). Those are almost certainly expressed in the same
  "engine-forward-axis" convention as bind was, so they'll likely need
  the *same* per-bone axis correction conjugated onto each animated
  frame's quaternion before playback looks right — flagging this now so
  it's not a surprise; happy to take that on next.
- **`Meshes` empty**: no longer created. Mesh and hitbox glTF nodes are
  now scene-root nodes directly instead of children of a transform-less
  grouping node — Blender reparents every skinned mesh under the
  Armature on import regardless (see round 1's notes), so the grouping
  node was serving no purpose beyond being the leftover empty you
  reported. `blender_organize.py`'s cleanup step for it is still there
  but is now just defensive/legacy, for re-running against any `.gltf`
  you already exported before this change.
- **`--scale`**: new flag (default `0.01`), applied uniformly to every
  exported position — mesh vertices, hitbox corners, bone bind
  translations, and animation translation channels (never rotations).
  The source engine's units come out human-scale-in-centimeters (this
  sample skeleton is ~170 units tall); `0.01` brings that to meters, so
  nothing needs a manual "Apply Scale" in Blender after import. Pass
  `--scale 1.0` to keep raw engine units if you'd rather scale in
  Blender yourself.

## Files

- `chunkfmt.py` — generic chunk-container reader shared by both formats.
- `nfo_parser.py` — `.NFO` → `NFOModel` (meshes, materials, skeleton, hitboxes).
- `key_parser.py` — `.KEY` → `KeyAnimation` (per-bone TRS keyframes).
- `mathutil.py` — matrix/quaternion decomposition helpers.
- `gltf_export.py` — `NFOModel` (+ `KeyAnimation`s) → `pygltflib.GLTF2`.
- `convert_all.py` — batch CLI driver; the thing you actually run.
- `blender_organize.py` — run inside Blender after import to build LOD
  Collections (see above).
