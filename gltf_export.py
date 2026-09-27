"""
Builds a single .gltf (+ external .bin) from a parsed NFOModel plus zero or
more KeyAnimation clips, using pygltflib for the schema/container and a
hand-rolled binary blob for buffers (pygltflib has no high-level "add mesh"
API).

ARCHITECTURE (rewritten after Blender-side testing found real bugs in the
first version -- see README changelog for what changed and why):

  * All mesh vertex positions (position/UV/normal arrays inside MSH1) are
    stored in one consistent whole-model bind space, NOT bone-local space
    -- confirmed by checking real bounding boxes (e.g. the head-cap mesh's
    own bbox sits at Y=155..180, matching head height in the full-body
    mesh's own Y=0.5..175 bbox; a bone-local mesh would instead be small
    and centered near its own bone's origin). Hitbox (BOX1) corners are
    the same: their per-hitbox bbox ranges line up with body-segment
    height (pelvis/torso/head), not bone-local offsets.

  * Because of that, EVERY mesh -- not just ones with real ZTR1 weight
    data -- is exported as a proper glTF skin: meshes with only one
    influencing bone (e.g. the caps, wound decals, hitboxes) simply get a
    single joint at weight 1.0 covering all their vertices. This avoids
    ever double-applying a bone's transform on top of already-absolute
    vertex data (the bug behind "hat position is wrong" and very likely
    behind "geometry looks twisted" too -- a mesh rigidly parented under
    a bone node, when its vertices are already in world space, gets that
    bone's full world transform applied a second time). It also means
    every mesh -- hats included -- correctly follows bone animation.

  * Because every mesh is skinned, Blender's importer will reparent every
    mesh OBJECT directly under the Armature object regardless of glTF
    node nesting (this is standard Blender glTF-importer behaviour, not
    something we can override from the file side). So we no longer create
    "LOD1"/"LOD2"/... grouping nodes in the glTF -- they'd just become
    useless empty objects, which is exactly what was reported. Instead,
    every object's *name* carries a clean "lod{N}_" prefix, and a
    companion script (`blender_organize.py`) sorts objects into real
    Blender Collections by that name after import.

  * Only the real skeleton bones (model.nodes[:bone_count]) become glTF
    nodes. The extra per-mesh "attachment" TRA1 entries are metadata only
    (name + which bone a mesh belongs to) -- previously they were ALSO
    instantiated as empty glTF nodes with a mesh child of the same name,
    which is exactly the "empty + child.001" duplication that was
    reported. They're gone now.

  * Triangle winding is flipped relative to the first version -- Blender
    reported inverted/backface geometry.
"""
from __future__ import annotations
import math
import re
import numpy as np
import pygltflib as G

from nfo_parser import NFOModel, Mesh, Node, Hitbox
from key_parser import KeyAnimation
from mathutil import flat_to_matrix4x4, invert_matrix_numpy, matrix4x4_to_flat, multiply_matrices, trs_to_matrix, quat_multiply

DEFAULT_SCALE = 0.01
"""Uniform factor applied to every position value on export (mesh vertices,
hitbox corners, bone bind translations, and animation translation channels
-- never to rotations). The source engine's units come out roughly
human-scale-in-centimeters (e.g. this sample skeleton's overall height is
~170 units); 0.01 brings that to meters, Blender's default unit, so nothing
needs a manual "Apply Scale" step after import. Override via build_gltf's
or convert_all.py's `scale` argument if a different source model's units
don't match."""

AXIS_MATRICES = {
    'none': np.eye(4),
    # rotate +90 about X: source Z-up -> glTF Y-up
    'z_up_to_y_up': np.array([
        [1, 0, 0, 0],
        [0, 0, -1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 1],
    ], dtype=np.float64),
}

_LOD_INFIX_RE = re.compile(r'^lod(\d+)_\d+_(.*)$', re.IGNORECASE)


def clean_name(raw: str) -> str:
    """'lod1_0_Mesh_Equipo_Amarillo' -> 'lod1_Mesh_Equipo_Amarillo' (drops
    the numeric LOD-distance infix; keeps the leading lod{N}_ so objects
    stay uniquely named across LODs without Blender appending '.001')."""
    m = _LOD_INFIX_RE.match(raw)
    if m:
        return f'lod{m.group(1)}_{m.group(2)}'
    return raw


class _Blob:
    def __init__(self):
        self.buf = bytearray()

    def add(self, data: bytes, align=4) -> int:
        while len(self.buf) % align != 0:
            self.buf.append(0)
        off = len(self.buf)
        self.buf += data
        return off


class GLTFBuilder:
    def __init__(self):
        self.g = G.GLTF2()
        self.g.asset = G.Asset(generator='nfo2gltf', version='2.0')
        self.blob = _Blob()
        self.g.buffers.append(G.Buffer())
        self.g.scenes.append(G.Scene(nodes=[]))
        self.g.scene = 0
        self.materials_index = {}

    def _add_view(self, data: bytes, target=None) -> int:
        off = self.blob.add(data)
        bv = G.BufferView(buffer=0, byteOffset=off, byteLength=len(data))
        if target is not None:
            bv.target = target
        self.g.bufferViews.append(bv)
        return len(self.g.bufferViews) - 1

    def add_accessor_f3(self, arr, target=None, minmax=False):
        arr = np.asarray(arr, dtype=np.float32).reshape(-1, 3)
        bv = self._add_view(arr.tobytes(), target)
        acc = G.Accessor(bufferView=bv, componentType=G.FLOAT, count=len(arr), type=G.VEC3)
        if minmax and len(arr):
            acc.min = arr.min(axis=0).tolist()
            acc.max = arr.max(axis=0).tolist()
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_f2(self, arr, target=None):
        arr = np.asarray(arr, dtype=np.float32).reshape(-1, 2)
        bv = self._add_view(arr.tobytes(), target)
        acc = G.Accessor(bufferView=bv, componentType=G.FLOAT, count=len(arr), type=G.VEC2)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_f4(self, arr):
        arr = np.asarray(arr, dtype=np.float32).reshape(-1, 4)
        bv = self._add_view(arr.tobytes())
        acc = G.Accessor(bufferView=bv, componentType=G.FLOAT, count=len(arr), type=G.VEC4)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_indices(self, arr):
        arr = np.asarray(arr, dtype=np.uint32)
        bv = self._add_view(arr.tobytes(), target=G.ELEMENT_ARRAY_BUFFER)
        acc = G.Accessor(bufferView=bv, componentType=G.UNSIGNED_INT, count=len(arr), type=G.SCALAR)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_joints4(self, arr):
        arr = np.asarray(arr, dtype=np.uint16).reshape(-1, 4)
        bv = self._add_view(arr.tobytes())
        acc = G.Accessor(bufferView=bv, componentType=G.UNSIGNED_SHORT, count=len(arr), type=G.VEC4)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_floats_scalar(self, arr):
        arr = np.asarray(arr, dtype=np.float32)
        bv = self._add_view(arr.tobytes())
        acc = G.Accessor(bufferView=bv, componentType=G.FLOAT, count=len(arr), type=G.SCALAR)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def add_accessor_mat4(self, arr_4x4_list):
        arr = np.asarray(arr_4x4_list, dtype=np.float32).reshape(-1, 16)
        bv = self._add_view(arr.tobytes())
        acc = G.Accessor(bufferView=bv, componentType=G.FLOAT, count=len(arr), type=G.MAT4)
        self.g.accessors.append(acc)
        return len(self.g.accessors) - 1

    def get_or_create_material(self, name, rgba, texture_uri):
        key = (name, texture_uri)
        if key in self.materials_index:
            return self.materials_index[key]
        pbr = G.PbrMetallicRoughness(
            baseColorFactor=[c / 255.0 for c in rgba[:3]] + [rgba[3] / 255.0 if len(rgba) > 3 else 1.0],
            metallicFactor=0.0, roughnessFactor=0.8,
        )
        if texture_uri:
            img_idx = len(self.g.images)
            self.g.images.append(G.Image(uri=texture_uri))
            tex_idx = len(self.g.textures)
            self.g.textures.append(G.Texture(source=img_idx))
            pbr.baseColorTexture = G.TextureInfo(index=tex_idx)
        mat = G.Material(name=name, pbrMetallicRoughness=pbr, alphaMode='MASK', alphaCutoff=0.5,
                          doubleSided=True)
        idx = len(self.g.materials)
        self.g.materials.append(mat)
        self.materials_index[key] = idx
        return idx


def build_gltf(model: NFOModel, animations: list, axis_mode='none',
                fps=30.0, export_hulls=True, export_hitboxes=True,
                texture_lookup=None, rotation_mode='key_only',
                scale=DEFAULT_SCALE) -> G.GLTF2:
    """
    model: parsed NFOModel
    animations: list[KeyAnimation] compatible with this model's skeleton
    axis_mode: key into AXIS_MATRICES (leave 'none' -- confirmed correct
               out of the box: source is already +Y up / -Z forward)
    texture_lookup(filename_from_nfo) -> relative uri string or None
    scale: uniform factor applied to every exported position (see
           DEFAULT_SCALE above)
    """
    b = GLTFBuilder()
    axis_fix = AXIS_MATRICES[axis_mode]
    bone_count = model.bone_count

    # ---------------- skeleton (real bones only) ------------------------
    # Bind translation comes from trusted skin-weight-centroid mesh data;
    # bind ROTATION comes from each bone's own TRA1 matrix used directly as
    # an absolute/world rotation (not composed hierarchically) -- both
    # independently validated, see nfo_parser.compute_bone_bind_transforms.
    from nfo_parser import compute_bone_bind_transforms
    local_translations, local_quats, r_absolute, fallback_bones = compute_bone_bind_transforms(model)
    local_translations = [t * scale for t in local_translations]
    if fallback_bones:
        names = ', '.join(model.nodes[i].name for i in fallback_bones)
        print(f'  note: {len(fallback_bones)} bone(s) had no skin-weight data to '
              f'derive a rest position from, placed at their parent instead: {names}')

    node_indices = [None] * bone_count
    local_trs = [None] * bone_count

    for i in range(bone_count):
        node = model.nodes[i]
        t = local_translations[i]
        q = local_quats[i]
        s = np.array([1.0, 1.0, 1.0])
        local_trs[i] = (t, q, s)
        gn = G.Node(name=node.name, translation=t.tolist(), rotation=q.tolist(), scale=s.tolist())
        idx = len(b.g.nodes)
        b.g.nodes.append(gn)
        node_indices[i] = idx

    roots = []
    for i in range(bone_count):
        node = model.nodes[i]
        gi = node_indices[i]
        if node.parent == -1:
            roots.append(i)
            if not np.allclose(axis_fix, np.eye(4)):
                t, q, s = local_trs[i]
                M = axis_fix @ trs_to_matrix(t, q, s)
                nt, nq, ns = decompose_colmatrix(M)
                b.g.nodes[gi].translation = nt.tolist()
                b.g.nodes[gi].rotation = nq.tolist()
                b.g.nodes[gi].scale = ns.tolist()
        else:
            parent_gi = node_indices[node.parent]
            pnode = b.g.nodes[parent_gi]
            if pnode.children is None:
                pnode.children = []
            pnode.children.append(gi)

    root_node_indices = [node_indices[i] for i in roots]
    b.g.scenes[0].nodes = list(root_node_indices)

    world = [None] * bone_count

    def get_world(i):
        if world[i] is not None:
            return world[i]
        t, q, s = local_trs[i]
        M = trs_to_matrix(t, q, s)
        if model.nodes[i].parent == -1:
            if not np.allclose(axis_fix, np.eye(4)):
                M = axis_fix @ M
            world[i] = M
        else:
            world[i] = get_world(model.nodes[i].parent) @ M
        return world[i]

    for i in range(bone_count):
        get_world(i)

    skin_index = None
    if bone_count > 0:
        joints = [node_indices[i] for i in range(bone_count)]
        ibms = [np.linalg.inv(get_world(i)).T.astype(np.float32).flatten().tolist()
                for i in range(bone_count)]
        acc = b.add_accessor_mat4(ibms)
        skin = G.Skin(joints=joints, inverseBindMatrices=acc,
                       skeleton=root_node_indices[0] if root_node_indices else None)
        b.g.skins.append(skin)
        skin_index = len(b.g.skins) - 1

    # ---------------- materials ------------------------------------------
    material_indices = []
    for mat in model.materials:
        uri = texture_lookup(mat.texture) if texture_lookup else None
        material_indices.append(b.get_or_create_material(mat.name, mat.diffuse_rgba, uri))
    if not material_indices:
        material_indices = [b.get_or_create_material('default', (200, 200, 200, 255), None)]

    heridas_uri = texture_lookup('heridas') if texture_lookup else None
    heridas_mat_idx = b.get_or_create_material('heridas', (255, 255, 255, 255), heridas_uri)

    # ---------------- meshes ----------------------------------------------
    for mesh in model.meshes:
        build_mesh_node(b, mesh, model, node_indices, material_indices,
                         skin_index, bone_count, heridas_mat_idx, scale)

    if export_hitboxes and model.hitboxes:
        add_hitboxes(b, model, node_indices, skin_index, scale)

    if export_hulls:
        print('  note: STP1 ("hull") data was re-examined and is NOT collision '
              "geometry -- it duplicates the render mesh's own triangles 1:1, so "
              "exporting it as a fake collision mesh was actively misleading. "
              "Not exporting it; see README.")

    # ---------------- animations -------------------------------------------
    for anim in animations:
        add_animation(b, anim, model, node_indices, fps, local_quats, rotation_mode, scale)

    buf_bytes = bytes(b.blob.buf)
    b.g.buffers[0].byteLength = len(buf_bytes)
    b.g.set_binary_blob(buf_bytes)
    return b.g


def decompose_colmatrix(M):
    from mathutil import quat_from_rotation_matrix
    t = M[0:3, 3].copy()
    basis_cols = M[0:3, 0:3]
    scale = np.linalg.norm(basis_cols, axis=0)
    scale_safe = np.where(scale < 1e-12, 1.0, scale)
    R = basis_cols / scale_safe[None, :]
    q = quat_from_rotation_matrix(R)
    return t, q, scale


def _single_joint_skin_group(mesh: Mesh, model: NFOModel) -> list:
    """Synthesize a ZTR1-shaped skin group for a mesh that has no real
    per-vertex weight data: 100% weight to whichever bone the mesh's own
    node is parented to (its vertex data is already in whole-model space,
    same as everything else, so a single-joint skin -- not a hierarchy
    reparent -- is what correctly follows that bone without double-
    applying a transform)."""
    bone_idx = 0
    if 0 <= mesh.node_index < len(model.nodes):
        parent = model.nodes[mesh.node_index].parent
        if 0 <= parent < model.bone_count:
            bone_idx = parent
    return [(bone_idx, [(pi, 1.0) for pi in range(len(mesh.positions))])]


def build_mesh_node(b: GLTFBuilder, mesh: Mesh, model: NFOModel, node_indices,
                     material_indices, skin_index, bone_count,
                     heridas_mat_idx, scale):
    vert_cache = {}
    positions, uvs, normals, orig_pos_idx = [], [], [], []

    def get_vertex(pi, ui, ni):
        key = (pi, ui, ni)
        v = vert_cache.get(key)
        if v is not None:
            return v
        v = len(positions)
        vert_cache[key] = v
        pos = mesh.positions[pi] if pi < len(mesh.positions) else (0, 0, 0)
        positions.append(tuple(c * scale for c in pos))
        uvs.append(mesh.uvs[ui] if ui < len(mesh.uvs) else (0, 0))
        normals.append(mesh.normals[ni] if ni < len(mesh.normals) else (0, 0, 1))
        orig_pos_idx.append(pi)
        return v

    is_herida = 'herida' in mesh.name.lower()

    by_mat = {}
    for f in range(len(mesh.idx_pos)):
        mat_id = mesh.material_ids[f] if f < len(mesh.material_ids) else 0
        pa, pb, pc = mesh.idx_pos[f]
        ua, ub, uc = mesh.idx_uv[f]
        na, nb, nc = mesh.idx_normal[f]
        va = get_vertex(pa, ua, na)
        vb = get_vertex(pb, ub, nb)
        vc = get_vertex(pc, uc, nc)
        # winding flipped (source engine's front-face winding is opposite
        # glTF's CCW-front convention -- confirmed backwards in Blender)
        by_mat.setdefault(mat_id, []).append((va, vc, vb))

    if not positions:
        return

    uvs_flipped = [(u, 1.0 - v) for (u, v) in uvs]

    pos_acc = b.add_accessor_f3(positions, target=G.ARRAY_BUFFER, minmax=True)
    nrm_acc = b.add_accessor_f3(normals, target=G.ARRAY_BUFFER)
    uv_acc = b.add_accessor_f2(uvs_flipped, target=G.ARRAY_BUFFER)
    attributes = G.Attributes(POSITION=pos_acc, NORMAL=nrm_acc, TEXCOORD_0=uv_acc)

    skin_groups = mesh.skin_groups if mesh.skin_groups else _single_joint_skin_group(mesh, model)
    per_pos_weights = {}
    for bone_idx, pairs in skin_groups:
        for pi, w in pairs:
            per_pos_weights.setdefault(pi, []).append((bone_idx, w))
    joints4, weights4 = [], []
    for pi in orig_pos_idx:
        entries = per_pos_weights.get(pi, [])
        entries = sorted(entries, key=lambda e: -e[1])[:4]
        if not entries:
            entries = [(0, 1.0)]
        js = [e[0] for e in entries] + [0] * (4 - len(entries))
        ws = [e[1] for e in entries] + [0.0] * (4 - len(entries))
        tot = sum(ws) or 1.0
        ws = [w / tot for w in ws]
        joints4.append(js[:4])
        weights4.append(ws[:4])
    attributes.JOINTS_0 = b.add_accessor_joints4(joints4)
    attributes.WEIGHTS_0 = b.add_accessor_f4(weights4)

    primitives = []
    for mat_id, tris in by_mat.items():
        idx_flat = [v for tri in tris for v in tri]
        idx_acc = b.add_accessor_indices(idx_flat)
        if is_herida:
            mi = heridas_mat_idx
        else:
            mi = material_indices[mat_id] if mat_id < len(material_indices) else material_indices[0]
        primitives.append(G.Primitive(attributes=attributes, indices=idx_acc, material=mi))

    name = clean_name(mesh.name)
    gmesh = G.Mesh(name=name, primitives=primitives)
    mesh_idx = len(b.g.meshes)
    b.g.meshes.append(gmesh)

    mesh_node = G.Node(name=name, mesh=mesh_idx, skin=skin_index)
    mnode_idx = len(b.g.nodes)
    b.g.nodes.append(mesh_node)
    # a scene-root node directly -- no synthetic grouping empty needed:
    # every skinned mesh gets reparented under the Armature by Blender's
    # importer regardless of glTF node nesting (see module docstring), so
    # a wrapper node here would only become the "Meshes" leftover empty
    # object previously reported.
    b.g.scenes[0].nodes.append(mnode_idx)


_BOX_TRIS = [
    (0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6),
    (0, 4, 5), (0, 5, 1), (1, 5, 6), (1, 6, 2),
    (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0),
]


def add_hitboxes(b: GLTFBuilder, model: NFOModel, node_indices, skin_index, scale):
    """Hitboxes shared across all LODs, one glTF mesh per BOX1, each
    single-joint-skinned to its bone so it tracks animation. Corners are
    already in whole-model space (verified against real data), so no
    extra transform is applied."""
    mat_idx = b.get_or_create_material('hitbox_debug', (255, 0, 0, 80), None)
    b.g.materials[mat_idx].alphaMode = 'BLEND'
    idx = [v for tri in _BOX_TRIS for v in tri]

    for hb_i, hb in enumerate(model.hitboxes):
        scaled_corners = [tuple(c * scale for c in corner) for corner in hb.corners]
        pos_acc = b.add_accessor_f3(scaled_corners, target=G.ARRAY_BUFFER, minmax=True)
        idx_acc = b.add_accessor_indices(idx)
        if skin_index is not None:
            joints4 = [[hb.bone_index if 0 <= hb.bone_index < model.bone_count else 0, 0, 0, 0]] * 8
            weights4 = [[1.0, 0.0, 0.0, 0.0]] * 8
            attrs = G.Attributes(POSITION=pos_acc, JOINTS_0=b.add_accessor_joints4(joints4),
                                  WEIGHTS_0=b.add_accessor_f4(weights4))
        else:
            attrs = G.Attributes(POSITION=pos_acc)
        prim = G.Primitive(attributes=attrs, indices=idx_acc, material=mat_idx)
        gmesh = G.Mesh(name=f'hitbox_{hb_i:02d}', primitives=[prim])
        mesh_idx = len(b.g.meshes)
        b.g.meshes.append(gmesh)
        node = G.Node(name=f'hitbox_{hb_i:02d}', mesh=mesh_idx,
                       skin=skin_index if skin_index is not None else None)
        nidx = len(b.g.nodes)
        b.g.nodes.append(node)
        b.g.scenes[0].nodes.append(nidx)


ROTATION_COMPOSE_MODES = ('key_then_bind', 'bind_then_key', 'key_only', 'key_conj_then_bind')

import math

def matrix4x4_to_quaternion(m):
    # m es una matriz 4x4 (lista de listas)
    # Extraemos los componentes de rotación puros de la matriz
    m00, m01, m02 = m[0][0], m[0][1], m[0][2]
    m10, m11, m12 = m[1][0], m[1][1], m[1][2]
    m20, m21, m22 = m[2][0], m[2][1], m[2][2]

    tr = m00 + m11 + m22

    if tr > 0.0:
        s = math.sqrt(tr + 1.0) * 2.0  # s = 4 * qw
        qw = 0.25 * s
        qx = (m21 - m12) / s
        qy = (m02 - m20) / s
        qz = (m10 - m01) / s
    elif (m00 > m11) and (m00 > m22):
        s = math.sqrt(1.0 + m00 - m11 - m22) * 2.0  # s = 4 * qx
        qw = (m21 - m12) / s
        qx = 0.25 * s
        qy = (m01 + m10) / s
        qz = (m02 + m20) / s
    elif m11 > m22:
        s = math.sqrt(1.0 + m11 - m00 - m22) * 2.0  # s = 4 * qy
        qw = (m02 - m20) / s
        qx = (m01 + m10) / s
        qy = 0.25 * s
        qz = (m12 + m21) / s
    else:
        s = math.sqrt(1.0 + m22 - m00 - m11) * 2.0  # s = 4 * qz
        qw = (m10 - m01) / s
        qx = (m02 + m20) / s
        qy = (m12 + m21) / s
        qz = 0.25 * s

    # Normalizamos por seguridad
    length = math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw)
    if length > 0:
        qx /= length
        qy /= length
        qz /= length
        qw /= length

    return (qx, qy, qz, qw)
def add_animation(b: GLTFBuilder, anim: KeyAnimation, model: NFOModel, node_indices, fps: float,
                   local_quats, rotation_mode='key_only', scale=DEFAULT_SCALE):
    """
    rotation_mode picks how each frame's KEY quaternion combines with the
    bone's bind rotation.

    Default is now `key_only` (full replacement, no bind composition) --
    the decompiled code has TWO different bone-update functions, and it
    matters which one applies:
      - UpdateAnimBones (normal single-clip playback -- the case here)
        does a straight copy: `this->matrix[bone] = RotationMatrix(key)`.
      - UpdateBones only uses `*=` (compose onto existing matrix) when an
        IK/blend-chain pointer is active -- i.e. for layering aim/IK
        corrections on top of an already-set base pose, not for playing
        a plain clip.
    An earlier version of this exporter mistook UpdateBones' `*=` for the
    general case and defaulted to composing with bind, which -- for a
    root bone whose KEY rotation happens to already closely match its own
    bind rotation -- produced a doubled rotation (e.g. 90+90=180DEG),
    which would look exactly like "everything's facing an extra 90
    degrees off" during playback while T-pose (no animation active,
    so this doesn't apply) stayed correct. The compose modes are kept
    below purely as an A/B fallback in case a different animation or
    model needs them.
    """
    n_frames = anim.frame_count
    if n_frames == 0:
        return
    times = [i / fps for i in range(n_frames)]
    time_acc = b.add_accessor_floats_scalar(times)

    name_to_model_idx = {n.name: i for i, n in enumerate(model.nodes[:model.bone_count])}

    channels, samplers = [], []
    for bone_i, bone_name in enumerate(anim.bone_names):
        model_idx = name_to_model_idx.get(bone_name)
        if model_idx is None:
            continue
        target_node = node_indices[model_idx]
        q_bind = local_quats[model_idx]

        trans, rots, scales = [], [], []
        for frame in anim.frames:
            # 1. Leemos tal cual lo tienes en el archivo
            qx, qy, qz, qw, px, py, pz, sx, sy, sz = frame[bone_i]

            # 2. TU combinación matemática que mantiene los huesos intactos
            t_final = [py * scale, px * scale, pz * scale]
            q_final = [qz, qy, qw, qx]

            # 3. Identificar si es el Root (hueso padre principal)
            is_root = (model.nodes[target_node].parent == -1)

            # 4. Levantar el modelo SOLO desde el Root
            if is_root:

                q_fix = np.array([0.0, 0.0, 0.70710678, 0.70710678])
            
                
                q_final_np = np.array(q_final)
                q_rotated = quat_multiply(q_fix, q_final_np)
                q_final = q_rotated.tolist()

            # 5. Guardar en glTF
            trans.extend(t_final)
            rots.extend(q_final)
            scales.extend([sx, sy, sz])
        t_out = b.add_accessor_f3(trans)
        r_out = b.add_accessor_f4(rots)
        s_out = b.add_accessor_f3(scales)
     

        for path, out_acc in (('translation', t_out), ('rotation', r_out)):
            samp_idx = len(samplers)
            samplers.append(G.AnimationSampler(input=time_acc, output=out_acc, interpolation='LINEAR'))
            channels.append(G.AnimationChannel(sampler=samp_idx,
                                                target=G.AnimationChannelTarget(node=target_node, path=path)))

    if channels:
        b.g.animations.append(G.Animation(name=anim.name, channels=channels, samplers=samplers))
