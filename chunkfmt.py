"""
Generic reader for the "vtFF" chunk container format used by both .NFO and
.KEY files from this (~2004) game engine.

Format, confirmed by hex-diffing a real .NFO against the Ghidra decompile:

    tag  : 4 bytes ASCII  (e.g. b"VTFF", b"INFO", b"MSH1", b"CSTR", ...)
    size : uint32 little-endian -- IMPORTANT: this size INCLUDES the 8-byte
           header itself, unlike classic RIFF/IFF chunks where size only
           counts the payload. So a chunk occupies exactly
           data[offset : offset+size] and the next sibling chunk starts at
           offset+size.
    data : (size - 8) bytes of payload.

The root chunk (VTFF in .NFO, FKEY in .KEY) sometimes stores size as
0xFFFFFFFF ("unknown / rest of file"); we treat that as "spans to EOF".

Within a chunk's payload, "child chunks" are not always used consistently
as a fully generic tree -- some chunk kinds are pure binary structs (e.g.
the MSH1 geometry INFO block), while others are literally sequences of
further tag+size chunks (e.g. an OBJ1 body is INFO, then several MTR1,
then several TRA1, then several LOD1, then several BOX1). This module
gives you both: a flat sibling-chunk scanner, and a tiny helper to peel
one chunk's header off a cursor.
"""
from __future__ import annotations
import struct
from dataclasses import dataclass


@dataclass
class Chunk:
    tag: str
    size: int          # total size, header included (or the sentinel 0xffffffff)
    header_off: int     # absolute offset of the 4-byte tag
    data_off: int        # absolute offset where payload starts (header_off+8)
    data_end: int        # absolute offset where payload ends (exclusive)

    @property
    def chunk_end(self) -> int:
        return self.data_end

    def data(self, buf: bytes) -> bytes:
        return buf[self.data_off:self.data_end]


def peek_chunk(buf: bytes, offset: int, region_end: int) -> Chunk | None:
    """Read one chunk header at `offset`. Returns None if it doesn't look
    like a valid tag (used to detect 'end of children')."""
    if offset + 8 > region_end:
        return None
    tag_b = buf[offset:offset + 4]
    if not all(32 <= b < 127 for b in tag_b):
        return None
    size = struct.unpack_from('<I', buf, offset + 4)[0]
    if size == 0xFFFFFFFF:
        data_end = region_end
    else:
        data_end = offset + size
        if data_end > region_end or size < 8:
            return None
    return Chunk(tag_b.decode('latin1'), size, offset, offset + 8, data_end)


def iter_siblings(buf: bytes, start: int, end: int):
    """Yield sibling Chunks packed one after another in [start, end)."""
    off = start
    while off < end:
        c = peek_chunk(buf, off, end)
        if c is None:
            return
        yield c
        off = c.data_end


def find_first(buf: bytes, start: int, end: int, tag: str) -> Chunk | None:
    for c in iter_siblings(buf, start, end):
        if c.tag == tag:
            return c
    return None


def read_cstr(buf: bytes, chunk: Chunk) -> str:
    """CSTR chunk payload is a null-terminated string (no extra length
    prefix -- the chunk `size` already tells us how many bytes to take)."""
    raw = chunk.data(buf)
    nul = raw.find(b'\x00')
    if nul != -1:
        raw = raw[:nul]
    return raw.decode('latin1', errors='replace')
