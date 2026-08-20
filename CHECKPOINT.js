const fs = require('fs');
const path = require('path');

// ============================================================================
// ⚙️ CONFIGURACIÓN DE OFFSETS Y PARÁMETROS
// ============================================================================
const CONFIG = {
    MSH1_HEADER_PADDING: 40,   // 0x01C4 + 40 = 0x01EC
    VERTEX_STRIDE: 12,          // 12 bytes por vértice (XYZ Float32)
    GLOBAL_FACES_OFFSET: 1620  // Offset 0x0654
};

// ============================================================================
// 📦 CLASE LECTORA DE CHUNKS IFF
// ============================================================================
class ChunkReader {
    constructor(buffer, offset = 0, length = null) {
        this.buffer = buffer;
        this.offset = offset;
        this.end = length !== null ? offset + length : buffer.length;
        this.cursor = this.offset;

        this.currentChunkId = null;
        this.currentChunkSize = 0;
        this.currentDataOffset = 0;
    }

    next() {
        if (this.currentChunkSize > 0) {
            this.cursor = this.currentDataOffset + (this.currentChunkSize - 8);
        }

        if (this.cursor + 8 > this.end) return false;

        this.currentChunkId = this.buffer.toString('ascii', this.cursor, this.cursor + 4);
        this.currentChunkSize = this.buffer.readUInt32LE(this.cursor + 4);
        this.currentDataOffset = this.cursor + 8;
        this.cursor += 8;

        if (this.currentChunkSize < 8 || (this.currentDataOffset + this.currentChunkSize - 8) > this.end) {
            return false;
        }

        return {
            id: this.currentChunkId,
            size: this.currentChunkSize,
            dataSize: this.currentChunkSize - 8
        };
    }

    readBytes(length) {
        if (this.cursor + length > this.end) {
            throw new Error(`Out of bounds en cursor ${this.cursor}`);
        }
        const data = this.buffer.slice(this.cursor, this.cursor + length);
        this.cursor += length;
        return data;
    }

    readUInt32LE() {
        const val = this.buffer.readUInt32LE(this.cursor);
        this.cursor += 4;
        return val;
    }

    createChildReader() {
        return new ChunkReader(
            this.buffer, 
            this.currentDataOffset, 
            this.currentChunkSize - 8
        );
    }
}

// ============================================================================
// 🎨 EXPORTADOR OBJ Y PARSER SANITIZADO
// ============================================================================
class CuchilloNFOParser {
    constructor(fileBuffer) {
        this.buffer = fileBuffer;
        this.vertices = [];
        this.normals = [];
        this.uvs = [];
        this.faces = [];
        this.materials = [];
    }

    addMaterial(name, textureName = '') {
        const matName = name || `Material_${this.materials.length + 1}`;
        this.materials.push({ name: matName, texture: textureName });
        return matName;
    }

    toHex(num) {
        return '0x' + num.toString(16).toUpperCase().padStart(4, '0');
    }

    isValidTriangle(v1, v2, v3) {
        const p1 = this.vertices[v1 - 1];
        const p2 = this.vertices[v2 - 1];
        const p3 = this.vertices[v3 - 1];

        if (!p1 || !p2 || !p3) return false;

        // Calcular magnitud del área vectorial 3D
        const ax = p2.x - p1.x, ay = p2.y - p1.y, az = p2.z - p1.z;
        const bx = p3.x - p1.x, by = p3.y - p1.y, bz = p3.z - p1.z;

        const cx = ay * bz - az * by;
        const cy = az * bx - ax * bz;
        const cz = ax * by - ay * bx;

        const areaSq = cx * cx + cy * cy + cz * cz;

        // Filtrar polígonos sin superficie o degenerados por padding
        return areaSq > 0.0001;
    }

    parseMSH1(mshChunk, currentMatName) {
        const mshReader = mshChunk.createChildReader();

        if (!mshReader.next() || mshReader.currentChunkId !== 'INFO') {
            return;
        }

        const infoReader = mshReader.createChildReader();
        const baseVertexIdx = this.vertices.length + 1;

        const infoPayload = infoReader.buffer.slice(infoReader.offset, infoReader.end);
        const infoAbsoluteStart = infoReader.offset;

        console.log(`\n==================================================`);
        console.log(`🔍 FILTRADO EXACTO DE CARAS EN MSH1 -> INFO`);
        console.log(`==================================================`);

        // 1. Extraer Vértices (Offset 0x01EC)
        const vRelativeOffset = CONFIG.MSH1_HEADER_PADDING;
        const vAbsoluteStart = infoAbsoluteStart + vRelativeOffset;

        // 2. Localizar inicio de Caras (1620 / 0x0654)
        let fAbsoluteStart = CONFIG.GLOBAL_FACES_OFFSET;
        let fRelativeOffset = fAbsoluteStart - infoAbsoluteStart;

        if (fRelativeOffset <= 0 || fRelativeOffset >= infoPayload.length) {
            for (let cursor = vRelativeOffset + 36; cursor < infoPayload.length - 12; cursor += 4) {
                const i0 = infoPayload.readUInt32LE(cursor);
                const i1 = infoPayload.readUInt32LE(cursor + 4);
                const i2 = infoPayload.readUInt32LE(cursor + 8);

                if (i0 === 0 && i1 === 1 && i2 === 2) {
                    fRelativeOffset = cursor;
                    fAbsoluteStart = infoAbsoluteStart + fRelativeOffset;
                    break;
                }
            }
        }

        const numVertices = Math.floor((fRelativeOffset - vRelativeOffset) / CONFIG.VERTEX_STRIDE);
        console.log(`📍 Vértices extraídos: ${numVertices} (desde ${this.toHex(vAbsoluteStart)})`);

        for (let i = 0; i < numVertices; i++) {
            const relCursor = vRelativeOffset + (i * CONFIG.VERTEX_STRIDE);
            const x = infoPayload.readFloatLE(relCursor);
            const y = infoPayload.readFloatLE(relCursor + 4);
            const z = infoPayload.readFloatLE(relCursor + 8);

            this.vertices.push({ x, y, z });
            this.normals.push({ x: 0, y: 1, z: 0 });
            this.uvs.push({ u: 0, v: 0 });
        }

        // 3. Extracción sanitizada de la tabla de caras (0x0654)
        const stp1Offset = this.buffer.indexOf('STP1', fAbsoluteStart);
        const fEndAbsolute = stp1Offset !== -1 ? stp1Offset : infoAbsoluteStart + infoPayload.length;

        const rawIndices = [];
        let fCursor = fRelativeOffset;
        const maxRelCursor = fEndAbsolute - infoAbsoluteStart;

        while (fCursor + 4 <= maxRelCursor) {
            const idx = infoPayload.readUInt32LE(fCursor);

            // Detener la lectura en cuanto alcancemos marcas de fin o paddings de alineación repetidos
            if (fCursor + 12 <= maxRelCursor) {
                const n1 = infoPayload.readUInt32LE(fCursor + 4);
                const n2 = infoPayload.readUInt32LE(fCursor + 8);
                
                // Si encontramos tres ceros consecutivos o valores fuera de rango, finaliza la tabla real
                if (idx === 0 && n1 === 0 && n2 === 0) {
                    break;
                }
            }

            if (idx < numVertices) {
                rawIndices.push(idx);
            } else {
                // Si encontramos un byte de control superior al número de vértices, pausamos si ya tenemos triplas
                if (rawIndices.length % 3 === 0 && rawIndices.length > 30) {
                    break;
                }
            }

            fCursor += 4;
        }

        // Agrupar en triplas y validar cada cara
        const validLength = rawIndices.length - (rawIndices.length % 3);
        const uniqueKeys = new Set();
        let faceCount = 0;
        let rejectedCount = 0;

        for (let i = 0; i < validLength; i += 3) {
            const v1 = rawIndices[i] + baseVertexIdx;
            const v2 = rawIndices[i + 1] + baseVertexIdx;
            const v3 = rawIndices[i + 2] + baseVertexIdx;

            // Filtro 1: Descartar vértices repetidos dentro del mismo triángulo
            if (v1 === v2 || v2 === v3 || v1 === v3) {
                rejectedCount++;
                continue;
            }

            // Filtro 2: Descartar triángulos con área nula / colineales
            if (!this.isValidTriangle(v1, v2, v3)) {
                rejectedCount++;
                continue;
            }

            // Filtro 3: Deduplicación por clave de topología
            const faceKey = [v1, v2, v3].sort((a, b) => a - b).join('-');
            if (uniqueKeys.has(faceKey)) {
                rejectedCount++;
                continue;
            }

            uniqueKeys.add(faceKey);
            this.faces.push({
                v: [v1, v2, v3],
                vt: [v1, v2, v3],
                vn: [v1, v2, v3],
                material: currentMatName
            });
            faceCount++;
        }

        console.log(`📍 Tabla procesada desde ${this.toHex(fAbsoluteStart)}:`);
        console.log(`   ✅ ${faceCount} Caras exactas del modelo exportadas.`);
        if (rejectedCount > 0) {
            console.log(`   🧹 ${rejectedCount} Caras sobrantes/basura filtradas con éxito.`);
        }
        console.log(`==================================================\n`);
    }

    exportFiles(outputPath) {
        if (this.vertices.length === 0) {
            console.error("❌ No se pudieron obtener vértices estructurados.");
            return;
        }

        const outputMtlPath = outputPath.replace(/\.obj$/i, '.mtl');
        const mtlFileName = path.basename(outputMtlPath);

        let mtlContent = `# Materiales VTFF NFO\n\n`;
        if (this.materials.length === 0) {
            this.addMaterial('DefaultMaterial');
        }

        for (const mat of this.materials) {
            mtlContent += `newmtl ${mat.name}\nKa 1.0 1.0 1.0\nKd 0.8 0.8 0.8\nKs 0.0 0.0 0.0\nd 1.0\nillum 2\n`;
            if (mat.texture) mtlContent += `map_Kd ${mat.texture}\n`;
            mtlContent += `\n`;
        }
        fs.writeFileSync(outputMtlPath, mtlContent);

        let objContent = `# Exporter Perfeccionado VTFF -> OBJ\n`;
        objContent += `mtllib ${mtlFileName}\n\n`;

        for (const v of this.vertices) {
            objContent += `v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}\n`;
        }
        for (const uv of this.uvs) {
            objContent += `vt ${uv.u.toFixed(6)} ${uv.v.toFixed(6)}\n`;
        }
        for (const n of this.normals) {
            objContent += `vn ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}\n`;
        }

        let currentMat = null;
        for (const f of this.faces) {
            if (f.material !== currentMat) {
                currentMat = f.material;
                objContent += `\nusemtl ${currentMat}\n`;
            }
            objContent += `f ${f.v[0]}/${f.vt[0]}/${f.vn[0]} ${f.v[1]}/${f.vt[1]}/${f.vn[1]} ${f.v[2]}/${f.vt[2]}/${f.vn[2]}\n`;
        }

        fs.writeFileSync(outputPath, objContent);
        console.log(`🎉 MODELO LIMPIO Y EXACTO GENERADO: ${outputPath}`);
    }
}

// ============================================================================
// 🚀 EJECUCIÓN
// ============================================================================
function parseNFOFile(inputFile) {
    const fileBuffer = fs.readFileSync(inputFile);
    const outputPath = inputFile.replace(/\.nfo$/i, '.obj').replace(/\.nfos\//i, './');

    const rootReader = new ChunkReader(fileBuffer);
    const exporter = new CuchilloNFOParser(fileBuffer);

    if (!rootReader.next() || rootReader.currentChunkId !== 'VTFF') {
        throw new Error("El archivo no contiene la firma mágica 'VTFF'");
    }

    const vtffReader = rootReader.createChildReader();

    if (!vtffReader.next() || vtffReader.currentChunkId !== 'INFO') {
        throw new Error("Se esperaba el chunk INFO global de VTFF");
    }

    while (vtffReader.next()) {
        const rootId = vtffReader.currentChunkId;

        if (rootId === 'OBJ1') {
            const objReader = vtffReader.createChildReader();

            if (!objReader.next() || objReader.currentChunkId !== 'INFO') continue;

            objReader.readBytes(0x14);
            objReader.readBytes(0x40);

            let currentMatName = 'DefaultMaterial';

            while (objReader.next()) {
                const subId = objReader.currentChunkId;

                if (subId === 'MTR1') {
                    const mtrReader = objReader.createChildReader();
                    while (mtrReader.next()) {
                        if (mtrReader.currentChunkId === 'CSTR') {
                            const nameData = mtrReader.readBytes(mtrReader.currentChunkSize - 8);
                            const name = nameData.toString('ascii').replace(/\0/g, '').trim();
                            if (name) {
                                currentMatName = exporter.addMaterial(name);
                            }
                        }
                    }
                } 
                else if (subId === 'LOD1') {
                    const lodReader = objReader.createChildReader();
                    while (lodReader.next()) {
                        if (lodReader.currentChunkId === 'MSH1') {
                            exporter.parseMSH1(lodReader, currentMatName);
                        }
                    }
                }
            }
        }
    }

    exporter.exportFiles(outputPath);
}

const inputFile = process.argv[2] ? `./nfos/${process.argv[2]}` : './nfos/Cuchillo.NFO';
parseNFOFile(inputFile);