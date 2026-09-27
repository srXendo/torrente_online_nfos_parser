"""
Parser for .KEY animation files.

    FKEY (root, size usually 0xFFFFFFFF == "rest of file")
      INFO
        uint16 version_a, uint16 version_b
        uint32 bone_count
        uint32 frame_count
        CSTR x bone_count            bone names, in the SAME order as the
                                      first `bone_count` TRA1 nodes of the
                                      matching .NFO's skeleton.
        -- then a flat sequence of "event markers". Each marker is a
        -- normal 8-byte tag+size chunk header whose declared size is
        -- always exactly 8 (i.e. it has NO payload of its own) followed
        -- immediately by raw, un-chunked binary data whose length depends
        -- on which marker it is:
        repeated:
          KEY1 (marker only)
            float               unknown/reserved (constant across frames in
                                 every sample seen so far; kept but not used
                                 for timing -- see NOTE below)
            per bone (bone_count times):
              float x3             quaternion x, y, z
              float x3             local position
              float x3             local scale
              float                quaternion w
          SND2 (marker only, zero-length payload)
                                 a sound-trigger event (e.g. footstep) at
                                 this point in the timeline; no extra data.

NOTE on timing: nothing in the file gives an explicit per-frame time or an
overall clip duration/FPS. We space frames evenly; pass --fps to the
converter if you know the game's animation frame rate (defaults to 30).
"""
from __future__ import annotations
import struct
from dataclasses import dataclass

class Reader:
    actual_offset: int = 0
    buffer: bytes
    def __init__ (self, buff):
        self.buffer = buff

    def read_bytes(self, offset):
        if len(self.buffer) <= self.actual_offset + offset:
            raise Exception("offset bound")
        result = self.buffer[self.actual_offset: self.actual_offset + offset]
        self.actual_offset = self.actual_offset + offset
        return result

    def skip_bytes(self, offset): 
        if len(self.buffer) <= self.actual_offset + offset:
            raise Exception("offset bound")
        self.actual_offset = self.actual_offset + offset

    def read_int(self):
        if len(self.buffer) < self.actual_offset + 4:
            raise Exception("offset bound")
        result = struct.unpack_from('<I', self.buffer, self.actual_offset)[0]
        self.actual_offset = self.actual_offset + 4
        return result
    def read_string(self, offset):
        if len(self.buffer) <= self.actual_offset + offset:
            raise Exception("offset bound")
        result = self.buffer[self.actual_offset: self.actual_offset + offset]
        self.actual_offset = self.actual_offset + offset
        return result.decode(encoding="latin-1")
    def set_offset(self, offset):
        self.actual_offset = offset 

@dataclass
class KeyAnimation:
    name: str
    bone_names: list
    frame_count: int
    # frames[f][bone_i] = (qx,qy,qz,qw, px,py,pz, sx,sy,sz)
    frames: list

def parse_frame_data(frame_bytes, root_size):
    bones_frame = []
    chunk_size = 40  # 40 bytes por hueso
    
    for i in range(root_size):
        offset = i * chunk_size
        # Extraemos los 10 floats de golpe (< = little-endian, 10f = 10 floats de 4 bytes)
        unpacked = struct.unpack_from("<10f", frame_bytes, offset)
        
        qx, qy, qz, qw, px, py, pz, sx, sy, sz = unpacked
        
        bones_frame.append({
            "qx": qx, "qy": qy, "qz": qz, "qw": qw,
            "px": px, "py": py, "pz": pz,
            "sx": sx, "sy": sy, "sz": sz
        })
        
    return bones_frame
def parse_key(buf: bytes, name: str = '') -> KeyAnimation:
    reader: Reader = Reader(buf)
    magic_header = reader.read_bytes(4)
    if magic_header != b'FKEY':
        raise ValueError('Not an FKEY/.KEY file')

    reader.skip_bytes(4) #origin code is same
    magic_header = reader.read_bytes(4)
    if magic_header != b'INFO':
        raise ValueError('Expected INFO chunk after FKEY header')

    reader.skip_bytes(8)

    root_size = reader.read_int()
    end = len(buf)
    this5 = reader.read_int()
    idx = 0
    bone_names = []
    while idx  < root_size:
        reader.skip_bytes(4)
        name_length = reader.read_int()
        name_bone = reader.read_string(name_length - 8)
        nul = name_bone.find("\x00")
        bone_names.append(name_bone[:nul])
        print("Primer: ", name_bone)
        idx = idx+1

    idx = 0
    centinele = True
    frames = []
    
    idx = 0
    while( idx < this5):
        if idx == 50:
            print("idx: ")
        uk_key = reader.read_string(4)
        if uk_key == "KEY1":
            #print(uk_key)#aqui xendo
            reader.skip_bytes(4)
            frame_data = reader.read_bytes(40 * root_size)
            unk_frame = reader.read_int()
            bone_vals = []
            for x in range(root_size):
                qx, qy, qz, qw, px, py, pz, sx, sy, sz = struct.unpack_from('<10f', frame_data, x * 40)

                bone_vals.append((qx, qy, qz, qw, px, py, pz, sx, sy, sz))
            frames.append(bone_vals)
            if unk_frame <= 0: 
                centinele = False

        elif(uk_key == b'SND1'):
                print(uk_key)
        else:
            centinele = False
        idx = idx + 1    
    print("frames: ", len(frames))
    centinele = True
    """"while(centinele):
        uk_key = reader.read_bytes(4)
        reader.skip_bytes(4)
        if(uk_key == b'SND1'):
            print(uk_key)
        else:
            centinele = False    


    print("Exit: ")"""

    """info_off = 16  # 8 (FKEY hdr) + 8 (INFO hdr)
    _v1, _v2, bone_count, frame_count = struct.unpack_from('<HHII', buf, info_off)
    off = info_off + 12

    
    for _ in range(bone_count):
        tag = buf[off:off + 4]
        if tag != b'CSTR':
            raise ValueError(f'Expected CSTR bone name at {off}, got {tag!r}')
        size = struct.unpack_from('<I', buf, off + 4)[0]
        raw = buf[off + 8:off + size]
        nul = raw.find(b'\x00')
        bone_names.append(raw[:nul].decode('latin1', errors='replace') if nul != -1
                           else raw.decode('latin1', errors='replace'))
        off += size

    frames = []
    while off < end - 8:
        tag = buf[off:off + 4]
        size = struct.unpack_from('<I', buf, off + 4)[0]
        if tag == b'KEY1':
            off += size  # marker header only (size == 8)
            off += 4  # skip the unused leading float
            bone_vals = []
            for _b in range(bone_count):
                vals = struct.unpack_from('<10f', buf, off)
                off += 40
                qx, qy, qz, qw, px, py, pz, sx, sy, sz = vals
                bone_vals.append((qx, qy, qz, qw, px, py, pz, sx, sy, sz))
            frames.append(bone_vals)
        elif tag == b'SND2':
            off += size  # zero-payload marker, nothing else to skip
        elif not all(32 <= b < 127 for b in tag):
            break
        else:
            # Unknown marker kind -- stop rather than risk misreading the
            # rest of the file as garbage floats.
            break"""

    return KeyAnimation(name=name, bone_names=bone_names, frame_count=len(frames), frames=frames)


if __name__ == '__main__':
    import sys
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
    anim = parse_key(data, name=sys.argv[1])
    print(f'bones={len(anim.bone_names)} frames={anim.frame_count}')
    print('bone names:', anim.bone_names[:5], '...')
    if anim.frames:
        qx, qy, qz, qw, px, py, pz, sx, sy, sz = anim.frames[0][0]
        print('frame0 bone0: quat=(%.4f %.4f %.4f %.4f) pos=(%.3f %.3f %.3f) scale=(%.3f %.3f %.3f)' %
              (qx, qy, qz, qw, px, py, pz, sx, sy, sz))
