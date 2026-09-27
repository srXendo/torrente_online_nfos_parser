"""
Run this INSIDE Blender (Scripting tab -> Open -> run) AFTER importing one
or more of the converted .gltf files into the SAME scene, to turn each
character's flat "everything is a direct child of the Armature" object list
into proper Collections:

    <CharacterName>            (top-level collection per character/armature)
        Armature
        LOD0
            lod0_torrente
            lod0_hat_amarillo
            lod0_hat_rojo
            lod0_heridas (collection)
                lod0_Herida_Cabeza
                ...
        LOD1 / LOD2   (same shape)
        Hitboxes

Supports multiple characters/armatures in one scene: each Armature object
(and everything skinned to it) is found and organized independently, so
you can import several models into one file and run this once for all of
them. An armature that's already alone inside its own collection is left
where it is; otherwise a new per-character collection is created for it
under the scene root.

Why this is a separate script rather than something the .gltf can do by
itself: plain glTF has no "Collection"/folder concept, only a node tree,
and Blender's importer always reparents any mesh object that has a skin
directly under its Armature object regardless of where it sits in that
node tree -- so there is no glTF-side trick that produces real Blender
Collections for skinned meshes. This has to happen after import.
"""
import re
import bpy

LOD_RE = re.compile(r'^lod(\d+)_(.*)$', re.IGNORECASE)
HERIDA_RE = re.compile(r'herida', re.IGNORECASE)


def get_or_create_collection(name, parent):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        parent.children.link(coll)
    elif coll.name not in parent.children:
        # exists but not linked under this parent -- link it there too
        try:
            parent.children.link(coll)
        except RuntimeError:
            pass  # already linked somewhere that would create a cycle; leave it
    return coll


def unlink_from_all(obj):
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)


def find_armatures():
    return [o for o in bpy.data.objects if o.type == 'ARMATURE']


def objects_owned_by_armature(armature_obj):
    """Every mesh object whose Armature modifier (or object parent, for the
    rare unskinned case) points at this armature."""
    owned = []
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        for mod in obj.modifiers:
            if mod.type == 'ARMATURE' and mod.object == armature_obj:
                owned.append(obj)
                break
        else:
            if obj.parent == armature_obj:
                owned.append(obj)
    return owned


def armature_already_isolated(armature_obj, owned_objects):
    """True if the armature is already the sole armature inside a collection
    that also contains (only) its own owned objects -- i.e. someone already
    organized it, so leave it alone."""
    for coll in armature_obj.users_collection:
        if coll == bpy.context.scene.collection:
            continue
        members = set(coll.all_objects)
        if armature_obj in members and members.issubset(set(owned_objects) | {armature_obj}):
            other_armatures = [o for o in members if o.type == 'ARMATURE' and o != armature_obj]
            if not other_armatures:
                return True
    return False


def organize_one_character(armature_obj, scene_root):
    owned = objects_owned_by_armature(armature_obj)

    if armature_already_isolated(armature_obj, owned):
        print(f'blender_organize: "{armature_obj.name}" already isolated, organizing in place.')
        char_coll = armature_obj.users_collection[0]
    else:
        char_name = armature_obj.name
        char_coll = get_or_create_collection(char_name, scene_root)
        unlink_from_all(armature_obj)
        char_coll.objects.link(armature_obj)

    # legacy cleanup: the exporter no longer creates a "Meshes" grouping
    # empty (meshes are scene-root nodes directly now), but drop one here
    # too in case this is run against a .gltf exported before that change.
    meshes_empty = bpy.data.objects.get('Meshes')
    if meshes_empty is not None and meshes_empty.parent == armature_obj:
        for child in list(meshes_empty.children):
            child.parent = None
        bpy.data.objects.remove(meshes_empty, do_unlink=True)

    lod_colls = {}
    herida_colls = {}
    hb_coll = None
    moved = 0

    for obj in owned:
        if obj.name.startswith('hitbox_'):
            hb_coll = hb_coll or get_or_create_collection(f'{armature_obj.name}_Hitboxes', char_coll)
            unlink_from_all(obj)
            hb_coll.objects.link(obj)
            moved += 1
            continue

        m = LOD_RE.match(obj.name)
        if not m:
            unlink_from_all(obj)
            char_coll.objects.link(obj)
            continue

        lod_num, rest = m.group(1), m.group(2)
        lod_name = f'LOD{lod_num}'
        lod_coll = lod_colls.setdefault(lod_name, get_or_create_collection(lod_name, char_coll))

        if HERIDA_RE.search(rest):
            herida_coll_name = f'lod{lod_num}_heridas'
            target = herida_colls.setdefault(
                herida_coll_name, get_or_create_collection(herida_coll_name, lod_coll))
        else:
            target = lod_coll

        unlink_from_all(obj)
        target.objects.link(obj)
        moved += 1

    print(f'blender_organize: "{armature_obj.name}" -> moved {moved} object(s) into '
          f'{len(lod_colls)} LOD collection(s).')


def main():
    scene_root = bpy.context.scene.collection
    armatures = find_armatures()
    if not armatures:
        print('blender_organize: no armatures found in scene, nothing to do.')
        return
    print(f'blender_organize: found {len(armatures)} armature(s): '
          f'{", ".join(a.name for a in armatures)}')
    for arm in armatures:
        organize_one_character(arm, scene_root)


if __name__ == '__main__':
    main()
