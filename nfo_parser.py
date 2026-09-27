"""
Parser for .NFO model files (this ~2004 game's proprietary 3D format).

File tree (all confirmed against a real sample by direct byte inspection):

    VTFF                                  root, size == whole file
      INFO (8 bytes)                        3x uint16 + uint32, format/version info
      OBJ1                                   the model
        INFO (96 bytes)                      6x int32 header + 4x4 identity matrix
                                              header = (lod_count, hitbox_count,
                                              unknown_c, material_count,
                                              skeleton_bone_count, mesh_count)
        MTR1 x material_count                 one skin/material
          CSTR                                  material name
          INFO (28 bytes)                       diffuse RGBA8, secondary RGBA8,
                                                  tertiary RGBA8, int, float, int, int
          CSTR                                  texture filename
        TRA1 x (skeleton_bone_count+mesh_count) one "node" (bone OR per-mesh
                                                 attachment node) -- first
                                                 skeleton_bone_count entries are
                                                 real skeleton bones (in the same
                                                 order used by .KEY animation
                                                 files); the rest, one per MSH1
                                                 (in file order across all LODs),
                                                 describe which bone that mesh is
                                                 rigidly parented to.
          CSTR                                    node name
          INFO (68 bytes)                        4x4 local matrix (row-major) +
                                                  int32 parent index (-1 = root)
        LOD1 x lod_count                       one level-of-detail
          INFO (16 bytes)                        header (mesh count in this LOD, ...)
          MSH1 x N                               one mesh/sub-object
            INFO                                  mesh geometry (see below)
            STP1 x hull_count                    per-face "hull"/collision record
              INFO                                 (material/group id, corner
                                                    count(=3), 3x(a,b,c) index
                                                    triple) -- a simplified,
                                                    separate index space from the
                                                    render geometry, used for
                                                    physical collision.
        BOX1 x hitbox_count                    per-bone oriented hit-box
      LHT1                                     (sibling of OBJ1; not parsed --
                                                 appears to be lighting info,
                                                 irrelevant to geometry/animation)

MSH1's INFO payload layout (all confirmed against real bytes -- the byte
count matches exactly for the sample file):

    int32          unknown0
    int32          node_index   -- direct index into OBJ1's TRA1 node list;
                                    this is THE authoritative link between a
                                    MSH1 and its name/parent-bone (do not
                                    assume file order == node order -- it
                                    isn't; verified against a real sample,
                                    where e.g. the 3rd MSH1 in LOD1 maps to
                                    node 36 "lod1_0_Herida_Cabeza", not node 31)
    int32          unknown2     (6 for the two team-color cap meshes seen in
                                    the sample, 2 for everything else --
                                    possibly a "part type" tag)
    int32 pos_count
    int32 uv_count
    int32 normal_count
    int32 face_count
    int32 hull_count       (STP1 chunk count that follows this MSH1)
    int32 skin_count       (vertex-weight "skin group" count, see below)
    int32 attach_count     (currently unused by this parser)
    vec3[pos_count]        positions
    vec2[uv_count]         texcoords
    vec3[normal_count]     normals
    int32[face_count]      material id per face
    (int32 x3)[face_count] position index per face-corner
    (int32 x3)[face_count] UV index per face-corner
    (int32 x3)[face_count] normal index per face-corner
    vec3 bbox_min
    vec3 bbox_max

Vertex-weight ("skin group") data is NOT inside the INFO chunk -- it comes
as `skin_count` separate ZTR1 sibling chunks after the STP1 (hull) chunks,
each one verified byte-for-byte against a real sample:

    ZTR1
      int32 bone_index
      int32 vert_count
      int32[vert_count]      vertex (position-index) list
      int32 has_weights
      float[vert_count]      weights (only present if has_weights != 0)
"""
from __future__ import annotations
import struct
from dataclasses import dataclass, field

import numpy as np

from chunkfmt import iter_siblings, find_first, read_cstr, peek_chunk, Chunk


@dataclass
class Material:
    name: str
    diffuse_rgba: tuple
    secondary_rgba: tuple
    tertiary_rgba: tuple
    shininess: float
    texture: str


@dataclass
class Node:
    name: str
    matrix: tuple   # 16 floats, row-major
    parent: int      # -1 for root
    is_bone: bool


@dataclass
class Mesh:
    name: str
    lod_index: int
    node_index: int          # index into NFOModel.nodes
    positions: list
    uvs: list
    normals: list
    material_ids: list        # per-face
    idx_pos: list             # per-face, 3 ints
    idx_uv: list
    idx_normal: list
    bbox_min: tuple
    bbox_max: tuple
    hull_tris: list           # list of (group_id, (a,b,c))  -- STP1 records
    skin_groups: list = field(default_factory=list)  # (bone_index, [(vert_idx, weight)])


@dataclass
class Hitbox:
    bone_index: int
    flag: int
    corners: list   # 8 x vec3


@dataclass
class NFOModel:
    lod_count: int
    hitbox_count: int
    material_count: int
    bone_count: int
    mesh_count: int
    materials: list
    nodes: list          # bones first, then mesh-attachment nodes
    meshes: list
    hitboxes: list


def _floats(buf, off, n):
    return struct.unpack_from('<%df' % n, buf, off)


def _ints(buf, off, n):
    return struct.unpack_from('<%di' % n, buf, off)


def parse_msh1(buf: bytes, msh1: Chunk, lod_index: int, mesh_order: int) -> Mesh:
    info = find_first(buf, msh1.data_off, msh1.data_end, 'INFO')
    if info is None:
        raise ValueError('MSH1 missing INFO header')
    base = info.data_off
    hdr = _ints(buf, base, 10)
    _u0, node_index, _u2, pos_c, uv_c, norm_c, face_c, hull_c, skin_c, _attach_c = hdr
    off = base + 40

    positions = [tuple(_floats(buf, off + i * 12, 3)) for i in range(pos_c)]
    off += pos_c * 12
    uvs = [tuple(_floats(buf, off + i * 8, 2)) for i in range(uv_c)]
    off += uv_c * 8
    normals = [tuple(_floats(buf, off + i * 12, 3)) for i in range(norm_c)]
    off += norm_c * 12
    material_ids = list(_ints(buf, off, face_c)) if face_c else []
    off += face_c * 4
    idx_pos = [tuple(_ints(buf, off + i * 12, 3)) for i in range(face_c)]
    off += face_c * 12
    idx_uv = [tuple(_ints(buf, off + i * 12, 3)) for i in range(face_c)]
    off += face_c * 12
    idx_normal = [tuple(_ints(buf, off + i * 12, 3)) for i in range(face_c)]
    off += face_c * 12
    bbox_min = tuple(_floats(buf, off, 3)); off += 12
    bbox_max = tuple(_floats(buf, off, 3)); off += 12

    hull_tris = []
    skin_groups = []
    for sib in iter_siblings(buf, msh1.data_off, msh1.data_end):
        if sib.tag == 'STP1':
            stp_info = find_first(buf, sib.data_off, sib.data_end, 'INFO')
            if stp_info is None:
                continue
            vals = _ints(buf, stp_info.data_off, (stp_info.data_end - stp_info.data_off) // 4)
            group_id, corner_count = vals[0], vals[1]
            rest = vals[2:2 + corner_count * 3]
            corners = [tuple(rest[i * 3:i * 3 + 3]) for i in range(corner_count)]
            hull_tris.append((group_id, corners))
        elif sib.tag == 'ZTR1':
            p = sib.data(buf)
            bone_index, vert_count = struct.unpack_from('<2i', p, 0)
            verts = struct.unpack_from('<%di' % vert_count, p, 8)
            o = 8 + vert_count * 4
            has_weights = struct.unpack_from('<i', p, o)[0]
            o += 4
            if has_weights:
                weights = struct.unpack_from('<%df' % vert_count, p, o)
            else:
                weights = [1.0] * vert_count
            skin_groups.append((bone_index, list(zip(verts, weights))))

    return Mesh(
        name=f'mesh_{lod_index}_{mesh_order}', lod_index=lod_index, node_index=node_index,
        positions=positions, uvs=uvs, normals=normals,
        material_ids=material_ids, idx_pos=idx_pos, idx_uv=idx_uv, idx_normal=idx_normal,
        bbox_min=bbox_min, bbox_max=bbox_max, hull_tris=hull_tris, skin_groups=skin_groups,
    )


def parse_material(buf: bytes, mtr1: Chunk) -> Material:
    children = list(iter_siblings(buf, mtr1.data_off, mtr1.data_end))
    cstrs = [c for c in children if c.tag == 'CSTR']
    info = find_first(buf, mtr1.data_off, mtr1.data_end, 'INFO')
    name = read_cstr(buf, cstrs[0]) if len(cstrs) > 0 else ''
    texture = read_cstr(buf, cstrs[1]) if len(cstrs) > 1 else ''
    diffuse = secondary = tertiary = (255, 255, 255, 255)
    shininess = 0.0
    if info is not None:
        payload = info.data(buf)
        if len(payload) >= 20:
            diffuse = tuple(payload[0:4])
            secondary = tuple(payload[4:8])
            tertiary = tuple(payload[8:12])
            shininess = struct.unpack_from('<f', payload, 16)[0]
    return Material(name=name, diffuse_rgba=diffuse, secondary_rgba=secondary,
                     tertiary_rgba=tertiary, shininess=shininess, texture=texture)


def parse_node(buf: bytes, tra1: Chunk, is_bone: bool) -> Node:
    children = list(iter_siblings(buf, tra1.data_off, tra1.data_end))
    cstr = next(c for c in children if c.tag == 'CSTR')
    info = next(c for c in children if c.tag == 'INFO')
    name = read_cstr(buf, cstr)
    payload = info.data(buf)
    matrix = _floats(buf, info.data_off, 16)
    parent = _ints(buf, info.data_off + 64, 1)[0]
    return Node(name=name, matrix=matrix, parent=parent, is_bone=is_bone)


def parse_hitbox(buf: bytes, box1: Chunk) -> Hitbox:
    payload_off = box1.data_off
    bone_index, flag = _ints(buf, payload_off, 2)
    corners = [tuple(_floats(buf, payload_off + 8 + i * 12, 3)) for i in range(8)]
    return Hitbox(bone_index=bone_index, flag=flag, corners=corners)


def parse_nfo(buf: bytes) -> NFOModel:
    vtff = peek_chunk(buf, 0, len(buf))
    if vtff is None or vtff.tag != 'VTFF':
        raise ValueError('Not a VTFF/.NFO file (bad root tag)')
    obj1 = find_first(buf, vtff.data_off, vtff.data_end, 'OBJ1')
    if obj1 is None:
        raise ValueError('No OBJ1 chunk found')

    hdr_chunk = find_first(buf, obj1.data_off, obj1.data_end, 'INFO')
    hdr = _ints(buf, hdr_chunk.data_off, 6)
    lod_count, hitbox_count, _unknown_c, material_count, bone_count, mesh_count = hdr

    materials, nodes, hitboxes = [], [], []
    lods_raw = []  # list of Chunk (LOD1)
    for c in iter_siblings(buf, obj1.data_off, obj1.data_end):
        if c.tag == 'MTR1':
            materials.append(parse_material(buf, c))
        elif c.tag == 'TRA1':
            is_bone = len(nodes) < bone_count
            nodes.append(parse_node(buf, c, is_bone))
        elif c.tag == 'LOD1':
            lods_raw.append(c)
        elif c.tag == 'BOX1':
            hitboxes.append(parse_hitbox(buf, c))

    meshes = []
    for lod_index, lod_chunk in enumerate(lods_raw):
        mesh_order = 0
        for c in iter_siblings(buf, lod_chunk.data_off, lod_chunk.data_end):
            if c.tag != 'MSH1':
                continue
            mesh = parse_msh1(buf, c, lod_index, mesh_order)
            # mesh.node_index came straight out of the MSH1 header and is the
            # authoritative link to its TRA1 node (name + parent bone) --
            # it is NOT necessarily sequential/contiguous, so look it up
            # rather than assuming file order matches node order.
            if 0 <= mesh.node_index < len(nodes):
                mesh.name = nodes[mesh.node_index].name
            else:
                mesh.name = f'mesh_lod{lod_index}_{mesh_order}'
            meshes.append(mesh)
            mesh_order += 1

    return NFOModel(
        lod_count=lod_count, hitbox_count=hitbox_count, material_count=material_count,
        bone_count=bone_count, mesh_count=mesh_count,
        materials=materials, nodes=nodes, meshes=meshes, hitboxes=hitboxes,
    )


def _bone_skin_centroids(model: 'NFOModel') -> dict:
    """Aggregate skin-weight centroids per bone across every mesh's ZTR1
    groups. Returns {bone_index: (weighted_centroid_xyz, total_weight)}."""
    import numpy as np
    agg = {}
    for mesh in model.meshes:
        for bone_idx, pairs in mesh.skin_groups:
            for pi, w in pairs:
                if pi >= len(mesh.positions):
                    continue
                pos = mesh.positions[pi]
                acc = agg.setdefault(bone_idx, [np.zeros(3), 0.0])
                acc[0] += np.array(pos) * w
                acc[1] += w
    return {k: (v[0] / v[1]) for k, v in agg.items() if v[1] > 0}


def compute_bone_rest_positions(model: 'NFOModel') -> list:
    """
    Derives each skeleton bone's REST WORLD position directly from trusted
    mesh data (the weighted centroid of vertices actually skinned to that
    bone via ZTR1 groups), rather than from the TRA1 matrix hierarchy.

    Why: extensive empirical testing (every combination of row/column-major,
    transposed/untransposed rotation, parent-first/child-first composition,
    even treating the matrices as inverse-bind) failed to reproduce
    anatomically sensible bone positions when composed down the hierarchy
    -- e.g. finger bones ended up hundreds of units away from the hand,
    spine bones badly out of order. But the *individual* per-bone
    translation values, and the skin-weight-derived positions below, are
    each independently sensible -- the bug is specifically in how the
    rotation part of TRA1 matrices is meant to compose, which could not be
    pinned down without the original engine's skinning source (not present
    in the supplied decompile). Deriving positions from the mesh instead
    sidesteps the problem entirely, since mesh vertex data is independently
    known-correct (it renders right without touching any bone math).

    Bones with no ZTR1 coverage in the sample (root anchors/dummies) fall
    back to their parent's resolved position -- harmless for those
    specific bones (root/footprint-reference/dummy/orienter), but flagged
    here in case a different model's equivalent bones matter more.

    Returns a list of (x,y,z) world positions, one per skeleton bone,
    plus (via the second return value) the set of bone indices that had to
    use the fallback so callers can warn about it.
    """
    centroids = _bone_skin_centroids(model)
    resolved = [None] * model.bone_count
    fallback_bones = []

    # topological order: parents always have a lower index in this format
    # (verified: every parent index seen so far is < child index), so a
    # single forward pass is safe.
    for i in range(model.bone_count):
        if i in centroids:
            resolved[i] = tuple(centroids[i])
        else:
            parent = model.nodes[i].parent
            fallback_bones.append(i)
            if 0 <= parent < model.bone_count and resolved[parent] is not None:
                resolved[i] = resolved[parent]
            else:
                resolved[i] = (0.0, 0.0, 0.0)
    return resolved, fallback_bones


def _bone_hierarchy(model: 'NFOModel') -> dict:
    """{parent_index: [child_index, ...]} in file order (ascending index),
    which -- per the format's own authoring order -- lists a bone's main
    chain-continuation child before side branches (e.g. Pelvis's spine
    child 'Columna' before its two leg children; Cuello's head child
    'Cabeza' before its two clavicle children)."""
    children = {i: [] for i in range(model.bone_count)}
    for i in range(model.bone_count):
        p = model.nodes[i].parent
        if 0 <= p < model.bone_count:
            children[p].append(i)
    return children


# Empirically-derived (see compute_bone_bind_transforms docstring): once the
# engine's own local axis that best represents "points at my child" is
# identified for a bone, this says which OTHER local axis carries roll/twist
# and whether it needs negating to land in glTF/Blender's local-Y-is-bone-
# direction convention. Confirmed against a manually-corrected reference
# skeleton for k=0 (all spine/leg/arm limb bones) and k=2 (foot bones,
# which -- unlike every other bone -- use local Z as their "forward" axis).
# k=1 never occurred in the sample skeleton; +1 is a neutral guess.
_ROLL_SIGN_BY_FORWARD_AXIS = {0: 1.0, 1: 1.0, 2: -1.0}


def _axis_dots(engine_R_i, direction) -> list:
    return [abs(float(np.dot(engine_R_i[:, k], direction))) for k in range(3)]


def _pick_reference_child(engine_R_i, real_child_dirs) -> tuple:
    """Which child's direction to trust as this bone's 'points toward my
    child' reference (used both to identify the forward axis AND as the
    tail direction itself) -- auto-detected per bone rather than assumed.

    Prefers the primary (first, file-order) child, since that's reliably
    the anatomical main-chain continuation (e.g. Pelvis's spine child
    before its two leg children; Cuello's head child before its two
    clavicle children). Only falls back to whichever *other* child gives
    the clearest (highest-confidence) single-axis alignment when the
    primary child's own top two candidate axes are too close to call --
    e.g. a hand bone whose first-indexed finger splays diagonally between
    two axes, where a same-hand sibling finger gives an unambiguous
    answer instead (confirmed against the reference skeleton: the hand
    bone's true tail direction there matches its *second* finger almost
    exactly, not its first).

    Returns (direction, axis, confidence).
    """
    primary_dir = real_child_dirs[0]
    primary_dots = _axis_dots(engine_R_i, primary_dir)
    order = sorted(range(3), key=lambda k: -primary_dots[k])
    if primary_dots[order[0]] - primary_dots[order[1]] > 0.15:
        return primary_dir, order[0], primary_dots[order[0]]
    best_dir, best_k, best_conf = None, None, -1.0
    for d in real_child_dirs[1:]:
        dots = _axis_dots(engine_R_i, d)
        k = int(np.argmax(dots))
        if dots[k] > best_conf:
            best_conf, best_k, best_dir = dots[k], k, d
    if best_dir is not None and best_conf > 0.85:
        return best_dir, best_k, best_conf
    return primary_dir, order[0], primary_dots[order[0]]


def _build_corrected_frame(engine_R_i, true_y, k):
    """Build an orthonormal, right-handed world-space rotation matrix whose
    local +Y axis is exactly true_y (the trusted mesh-centroid direction to
    the bone's primary child -- glTF/Blender's bone-points-along-Y
    convention), while keeping as much of the engine's own original roll
    reference as possible for local X/Z (see _ROLL_SIGN_BY_FORWARD_AXIS)."""
    ref_idx = (k + 2) % 3
    sign = _ROLL_SIGN_BY_FORWARD_AXIS.get(k, 1.0)
    z_raw = sign * engine_R_i[:, ref_idx]
    z_perp = z_raw - np.dot(z_raw, true_y) * true_y
    n = np.linalg.norm(z_perp)
    if n < 1e-8:
        # true_y is (near-)parallel to the roll-reference axis too
        # (degenerate bone orientation) -- fall back to any perpendicular.
        alt = np.array([1.0, 0.0, 0.0]) if abs(true_y[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        z_perp = alt - np.dot(alt, true_y) * true_y
        n = np.linalg.norm(z_perp)
    z_axis = z_perp / n
    x_axis = np.cross(true_y, z_axis)
    return np.column_stack([x_axis, true_y, z_axis])


def _auto_correct_bind_rotations(model: 'NFOModel', r_absolute: list,
                                  world_positions: list, fallback_bones: list) -> list:
    """
    Re-derives each bone's WORLD bind rotation so its local +Y axis (glTF
    and Blender's bone-points-along-Y convention) actually points at its
    child, instead of using the raw TRA1 rotation matrix's own basis
    directly.

    Why this is needed: the raw TRA1 matrix IS the correct absolute/world
    orientation of each bone's own local coordinate frame (see the
    docstring on compute_bone_bind_transforms for how that was validated)
    -- but the original engine's convention for which local axis is
    "forward" (points toward the child bone) is NOT local Y. Comparing
    against a manually-corrected reference skeleton (T-pose bone tails
    pointed at the correct limbs by hand in Blender) shows it's local X for
    almost every bone (spine, arms, legs), but local Z specifically for the
    foot bones -- i.e. a per-bone-type authoring convention in the original
    content tool, not a bug in the matrix data itself. Blender/glTF always
    treat local Y as "bone direction" when turning a joint's rotation into
    a visible edit-bone head/tail/roll, so without this remap the bone
    *positions* (translations) come out correct but the bone *tails*
    (rotations) point along whatever the wrong axis happens to be -- which
    matches exactly what was reported (T-pose heads right, tails wrong).

    Rather than hardcoding "local X" (or a per-limb chain lookup), this
    auto-detects which local axis to use per bone from the bone's own real
    children's directions (trusted mesh-centroid positions), so it
    generalizes to other skeletons/models without per-model tuning -- see
    _detect_forward_axis and _build_corrected_frame.

    Bones with no real (non-fallback) child of their own -- leaves like
    fingertips, or bones whose only children are position-fallback helpers
    -- have no independent direction to check, so they inherit whatever
    correction (as a relative rotation) was applied to their parent,
    preserving the engine's original local offset between the two.
    """
    children = _bone_hierarchy(model)
    fallback_set = set(fallback_bones)
    corrected = [None] * model.bone_count

    for i in range(model.bone_count):
        real_kids = [c for c in children[i] if c not in fallback_set]
        child_dirs = []
        for c in real_kids:
            d = world_positions[c] - world_positions[i]
            n = np.linalg.norm(d)
            if n > 1e-6:
                child_dirs.append(d / n)

        frame = None
        if child_dirs:
            true_y, k, _conf = _pick_reference_child(r_absolute[i], child_dirs)
            frame = _build_corrected_frame(r_absolute[i], true_y, k)

        if frame is None:
            parent = model.nodes[i].parent
            if 0 <= parent < model.bone_count and corrected[parent] is not None:
                # inherit parent's correction as a relative (conjugation)
                # transform, preserving this bone's own original local
                # offset from its parent in the engine data.
                relative = np.linalg.inv(r_absolute[parent]) @ r_absolute[i]
                frame = corrected[parent] @ relative
            else:
                frame = r_absolute[i]

        corrected[i] = frame

    return corrected


def compute_bone_bind_transforms(model: 'NFOModel'):
    """
    Derives each bone's REST local (translation, rotation-quaternion) for the
    glTF node hierarchy, combining two independently-validated findings:

    1. World *positions* come from compute_bone_rest_positions (mesh
       skin-weight centroids) -- see that function's docstring.

    2. World *rotations* come from each bone's OWN TRA1 matrix directly,
       transposed into column-vector convention, used AS-IS -- i.e. TRA1
       rotations are already absolute/world per bone (matching everything
       else in this format: mesh vertices and hitbox corners are also
       absolute, not parent-local), NOT parent-relative despite living
       inside a parent-child hierarchy. This was validated two ways:
         - reconstructing local (parent-relative) rotation as
           inverse(R_absolute[parent]) @ R_absolute[child] and recomposing
           it hierarchically exactly reproduces R_absolute[child] (sanity
           check).
         - independently, for every bone in the sample skeleton, that
           bone's OWN raw rotation matrix's local X axis (negated for the
           spine/leg chain, positive for the arm chain -- a left/right
           mirroring convention) aligns with the direction toward its
           child (from the trusted mesh-centroid positions) with
           |dot| > 0.88 for every bone with a meaningful bone length,
           including bones 7-8 levels deep in the hierarchy. Treating the
           rotations as needing hierarchical composition (the "normal"
           skeletal-rig assumption) was what produced the nonsensical,
           divergent bone positions found earlier.

    3. The world rotation from (2) is then run through
       _auto_correct_bind_rotations, which remaps each bone's own basis so
       local +Y (not whichever axis the raw matrix happens to use) points
       at the child -- see that function's docstring for why this is a
       separate step from (2) and how it was derived. This is what actually
       fixes T-pose bone *tail* orientation; (2) alone already gave correct
       bone *head* positions once combined with (1).

    Returned per-bone local translation is the mesh-derived world-position
    delta from its parent, ROTATED INTO the parent's absolute rotation
    frame (so that standard glTF/Blender hierarchical composition
    reconstructs the correct mesh-derived world position).
    """
    import numpy as np
    from mathutil import quat_from_rotation_matrix

    world_positions, fallback_bones = compute_bone_rest_positions(model)
    world_positions = [np.array(p) for p in world_positions]

    r_absolute = []
    for i in range(model.bone_count):
        M = np.asarray(model.nodes[i].matrix, dtype=np.float64).reshape(4, 4)
        r_absolute.append(M[0:3, 0:3].T)

    r_absolute = _auto_correct_bind_rotations(model, r_absolute, world_positions, fallback_bones)

    local_translations = [None] * model.bone_count
    local_quats = [None] * model.bone_count
    for i in range(model.bone_count):
        parent = model.nodes[i].parent
        if parent == -1:
            local_translations[i] = world_positions[i]
            r_local = r_absolute[i]
        else:
            r_parent_inv = np.linalg.inv(r_absolute[parent])
            delta = world_positions[i] - world_positions[parent]
            local_translations[i] = r_parent_inv @ delta
            r_local = r_parent_inv @ r_absolute[i]
        local_quats[i] = quat_from_rotation_matrix(r_local)
    return local_translations, local_quats, r_absolute, fallback_bones


if __name__ == '__main__':
    import sys
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
    m = parse_nfo(data)
    print(f'lods={m.lod_count} hitboxes={m.hitbox_count} materials={m.material_count} '
          f'bones={m.bone_count} meshes={m.mesh_count}')
    for mat in m.materials:
        print('  material:', mat.name, mat.texture, mat.diffuse_rgba)
    for i, n in enumerate(m.nodes):
        kind = 'bone' if n.is_bone else 'mesh-node'
        print(f'  node[{i}] ({kind}) parent={n.parent} name={n.name}')
    for mesh in m.meshes:
        print(f'  mesh {mesh.name}: verts={len(mesh.positions)} faces={len(mesh.idx_pos)} '
              f'hulls={len(mesh.hull_tris)} skin_groups={len(mesh.skin_groups)}')
