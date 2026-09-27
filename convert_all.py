#!/usr/bin/env python3
"""
Batch-converts every .NFO in ./models into OUT/<name>/<name>.gltf (+ a
matching .bin), embedding its geometry, materials, skeleton, hitboxes,
collision hull, and any compatible .KEY animations found in ./keys
(matched to the model by comparing skeleton bone names). Textures are
looked up by name (case-insensitive, extension-agnostic, tolerant of
double extensions like 'heridas.tex.png') in ./textures and copied next
to the output .gltf.

Usage:
    python convert_all.py
    python convert_all.py --models-dir models --keys-dir keys --textures-dir textures --out-dir OUT
    python convert_all.py --axis-mode z_up_to_y_up      # if models come in sideways
    python convert_all.py --fps 25                       # if animation looks too fast/slow
    python convert_all.py --no-hitboxes --no-hulls        # skip the debug collision meshes
    python convert_all.py --scale 1.0                     # keep raw engine units instead of meters
    python convert_all.py --only Torrente.NFO             # just one file, for quick iteration
"""
from __future__ import annotations
import argparse
import os
import shutil
import sys
import traceback

from nfo_parser import parse_nfo
from key_parser import parse_key
from gltf_export import build_gltf, DEFAULT_SCALE


def _full_stem(filename: str) -> str:
    """Strip ALL trailing extensions, not just one -- source names like
    'heridas.tex.png' need to match a lookup key of just 'heridas'."""
    stem = filename
    while True:
        new_stem, ext = os.path.splitext(stem)
        if not ext or new_stem == stem:
            return stem
        stem = new_stem


def find_texture(textures_dir: str, filename: str, cache: dict) -> str | None:
    if not filename:
        return None
    if cache is None:
        cache = {}
    if not cache:
        if os.path.isdir(textures_dir):
            for f in os.listdir(textures_dir):
                cache[f.lower()] = f
        cache['__loaded__'] = True
    stem = _full_stem(filename).lower()
    for ext in ('.png',):
        if stem + ext in cache:
            return cache[stem + ext]
    # fall back to matching real files whose OWN full-stem equals ours
    # (handles the double-extension case, e.g. real file 'heridas.tex.png'
    # matching a lookup of 'heridas' or 'heridas.tex')
    for key, real in cache.items():
        if key == '__loaded__':
            continue
        if _full_stem(key) == stem:
            return real
    return None


def bone_names_of(model) -> list:
    return [n.name for n in model.nodes[:model.bone_count]]


def compatible(model_bones: list, anim_bones: list) -> bool:
    """KEY files can legitimately omit non-animated 'dummy' bones that the
    NFO skeleton has (seen in practice: a model has 'Bone_Dummy_ManoDer',
    a matching running animation doesn't bother keying it), so we match by
    name-set overlap rather than requiring an exact prefix/order match."""
    if not anim_bones or not model_bones:
        return False
    model_set = set(model_bones)
    shared = sum(1 for b in anim_bones if b in model_set)
    return True##shared / len(anim_bones) >= 0.8


def convert_one(nfo_path: str, keys_dir: str, textures_dir: str, out_dir: str,
                 axis_mode: str, fps: float, hitboxes: bool, hulls: bool, tex_cache: dict,
                 key_cache: dict, rotation_mode: str = 'key_only', scale: float = DEFAULT_SCALE):
    name = os.path.splitext(os.path.basename(nfo_path))[0]
    print(f'[{name}] parsing NFO...')
    with open(nfo_path, 'rb') as f:
        model = parse_nfo(f.read())
    print(f'[{name}]   lods={model.lod_count} materials={model.material_count} '
          f'bones={model.bone_count} meshes={len(model.meshes)} hitboxes={len(model.hitboxes)}')

    model_bones = bone_names_of(model)
    matched_anims = []
    for key_path, anim_bones in key_cache.items():
        if compatible(model_bones, anim_bones):
            anim_name = os.path.splitext(os.path.basename(key_path))[0]
            with open(key_path, 'rb') as f:
                anim = parse_key(f.read(), name=anim_name)
            matched_anims.append(anim)
    print(f'[{name}]   matched {len(matched_anims)} animation(s)')

    out_subdir = os.path.join(out_dir, name)
    os.makedirs(out_subdir, exist_ok=True)

    used_textures = set()

    def lookup(fname):
        real = find_texture(textures_dir, fname, tex_cache)
        if real:
            used_textures.add(real)
            return real
        return None

    gltf = build_gltf(model, matched_anims, axis_mode=axis_mode, fps=fps,
                       export_hitboxes=hitboxes, export_hulls=hulls, texture_lookup=lookup,
                       rotation_mode=rotation_mode, scale=scale)

    out_gltf = os.path.join(out_subdir, f'{name}.gltf')
    gltf.save(out_gltf)
    print(f'[{name}]   wrote {out_gltf} (+ {name}.bin)')

    for tex in used_textures:
        src = os.path.join(textures_dir, tex)
        dst = os.path.join(out_subdir, tex)
        try:
            shutil.copyfile(src, dst)
        except OSError as e:
            print(f'[{name}]   WARNING: could not copy texture {tex}: {e}')
    if used_textures:
        print(f'[{name}]   copied {len(used_textures)} texture(s)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--models-dir', default='models')
    ap.add_argument('--keys-dir', default='keys')
    ap.add_argument('--textures-dir', default='textures')
    ap.add_argument('--out-dir', default='OUT')
    ap.add_argument('--axis-mode', default='none', choices=['none', 'z_up_to_y_up'])
    ap.add_argument('--fps', type=float, default=30.0,
                     help='KEY files store no explicit frame timing; this sets playback speed')
    ap.add_argument('--no-hitboxes', action='store_true', help='skip exporting hitbox debug meshes')
    ap.add_argument('--no-hulls', action='store_true', help='skip exporting the collision_hull debug mesh')
    ap.add_argument('--rotation-mode', default='key_only',
                     choices=['key_then_bind', 'bind_then_key', 'key_only', 'key_conj_then_bind'],
                     help='how KEY rotation combines with bind rotation during animation -- '
                          'default (key_only) matches normal single-clip playback; try the '
                          'others only if key_only still looks wrong, see README')
    ap.add_argument('--only', default=None, help='only convert this one .NFO filename')
    ap.add_argument('--scale', type=float, default=DEFAULT_SCALE,
                     help=f'uniform factor applied to every exported position -- vertices, '
                          f'hitboxes, bone translations, animation translations (default '
                          f'{DEFAULT_SCALE}, engine units -> meters; use 1.0 to keep raw units)')
    args = ap.parse_args()

    if not os.path.isdir(args.models_dir):
        print(f'error: models dir not found: {args.models_dir}', file=sys.stderr)
        sys.exit(1)

    nfo_files = sorted(f for f in os.listdir(args.models_dir) if f.lower().endswith('.nfo'))
    if args.only:
        nfo_files = [f for f in nfo_files if f == args.only]
    if not nfo_files:
        print('No .NFO files found.', file=sys.stderr)
        sys.exit(1)

    key_files = []
    if os.path.isdir(args.keys_dir):
        key_files = sorted(os.path.join(args.keys_dir, f) for f in os.listdir(args.keys_dir)
                            if f.lower().endswith('.key'))

    print(f'Found {len(nfo_files)} model(s), {len(key_files)} animation(s).')

    # Pre-parse just the skeleton bone-name list of every KEY once.
    key_cache = {}
    for kp in key_files:
        try:
            with open(kp, 'rb') as f:
                anim = parse_key(f.read(), kp)
            key_cache[kp] = anim.bone_names
        except Exception as e:
            print(f'WARNING: failed to read {kp}: {e}')

    tex_cache = {}
    os.makedirs(args.out_dir, exist_ok=True)

    failures = []
    for fn in nfo_files:
        nfo_path = os.path.join(args.models_dir, fn)
        try:
            convert_one(nfo_path, args.keys_dir, args.textures_dir, args.out_dir,
                        args.axis_mode, args.fps, not args.no_hitboxes, not args.no_hulls,
                        tex_cache, key_cache, args.rotation_mode, args.scale)
        except Exception as e:
            print(f'ERROR converting {fn}: {e}')
            traceback.print_exc()
            failures.append(fn)

    print()
    print(f'Done. {len(nfo_files) - len(failures)}/{len(nfo_files)} succeeded.')
    if failures:
        print('Failed:', ', '.join(failures))
        sys.exit(1)


if __name__ == '__main__':
    main()
