const fs = require('fs');
const exportObj = {
    vertex: [],
    faces: [],
    is_touch: false,
    counter: 0
}
class VtStream {
    constructor(bufferSize, buffer) {
        this.bufferSize = bufferSize;   // Offset +16 (stream_ptr + 4 en dwords)
        this.buffer = buffer;           // Offset +4  (stream_ptr[1])
        this.refCount = 0;              // Offset +12 (stream_ptr[3])
    }

    // En C++ esto representa la combinación de vtFile_Seek y vtFile_Read
    // Usa lecturas absolutas basadas en el offset, no un puntero secuencial.
    readAbsolute(offset, length) {
        if (offset + length > this.buffer.length) {
            throw new Error(`Out of bounds en offset ${offset}`);
        }
        return this.buffer.slice(offset, offset + length);
    }
}

class VtFFChunk {
    constructor(a2) {
        // Validación inicial
        if (!a2 || !a2.streamPtr) {
            throw new Error("Error en la creación del chunk");
        }

        this.streamPtr = a2.streamPtr;
        
        if (this.streamPtr && typeof this.streamPtr.refCount === 'number') {
            this.streamPtr.refCount++;
        }

        // Traducción literal: v4 = a2->header_pos + 8;
        const v4 = a2.headerPos + 8;
        this.headerPos = v4;
        this.dataPos = v4;

        this.unkFlag = false;
        this.chunkSize = 0;
        this.parentChunk = a2;
        this.chunkId = null;

        // Llamada a vtFFChunk::Next
        this.next();
    }

    next() {
        const parentChunk = this.parentChunk;
        let start_pos_new_chunk;

        // start_pos_new_chunk = parent_chunk->chunk_size + parent_chunk->header_pos;
        // Se añade fallback a bufferSize si el contenedor principal no tiene chunkSize.
        if (parentChunk && parentChunk.chunkSize !== undefined) {
            start_pos_new_chunk = parentChunk.chunkSize + parentChunk.headerPos;
        } else {
            start_pos_new_chunk = this.streamPtr.bufferSize;
        }

        let chunk_size = this.chunkSize;
        let header_pos = this.headerPos;

        if (chunk_size !== 0) {
            header_pos += chunk_size;
            this.headerPos = header_pos;
        }

        this.dataPos = header_pos;
        let header_pos_1 = this.headerPos;
        this.chunkSize = 0;

        if (header_pos_1 >= start_pos_new_chunk) {
            return 0;
        }

        // ==================================================
        // TRADUCCIÓN DE: vtFile_Seek + vtFile_Read
        // Usamos el offset absoluto (header_pos_1)
        // ==================================================
        
        // vtFile_Read(..., this->chunk_id, 4u);
        const idBuffer = this.streamPtr.readAbsolute(header_pos_1, 4);
        this.chunkId = idBuffer.toString("ascii");

        // vtFile_Read(..., &Buffer_length, 4u);
        const sizeBuffer = this.streamPtr.readAbsolute(header_pos_1 + 4, 4);
        const Buffer_length = sizeBuffer.readUInt32LE(0);

        if (Buffer_length < 8 || Buffer_length + this.headerPos > start_pos_new_chunk) {
            return 0;
        }

        const v9 = this.headerPos + 8;
        this.chunkSize = Buffer_length;
        this.dataPos = v9;
        
        return 1;
    }
    flush() {
        // En el C++ original, vtFFChunk::Flush hace comprobaciones de memoria/alineación.
        // En Node.js con buffers pre-cargados esta operación es transparente,
        // pero la definimos vacía para respetar las llamadas del desensamblado.
    }

    // Traducción de: char __thiscall vtFFChunk::FindFirst(vtFFChunk *this, char *Str2)
    findFirst(str2) {
        this.flush();
        const parent_chunk = this.parentChunk;
        let v5;

        if (parent_chunk !== null && parent_chunk !== undefined) {
            const v6 = parent_chunk.headerPos + 8;
            this.headerPos = v6;
            this.dataPos = v6;
            v5 = parent_chunk.headerPos + parent_chunk.chunkSize;
        } else {
            this.dataPos = this.headerPos;
            v5 = this.streamPtr.bufferSize;
        }

        let v7 = this.headerPos < v5;
        this.chunkSize = 0;

        if (v7) {
            do {
                const header_pos = this.headerPos;
                
                // vtFile_Read(..., this->chunk_id, 4u);
                const idBuffer = this.streamPtr.readAbsolute(header_pos, 4);
                this.chunkId = idBuffer.toString("ascii");

                // vtFile_Read(..., &Str2_temp, 4u);
                const sizeBuffer = this.streamPtr.readAbsolute(header_pos + 4, 4);
                const bufferSizeTemp = sizeBuffer.readUInt32LE(0); // Representa "Str2" local

                if (bufferSizeTemp < 8 || (header_pos + bufferSizeTemp) > v5) {
                    break;
                }

                const v14 = this.chunkId === str2;
                const v15 = this.headerPos;

                if (v14) {
                    this.chunkSize = bufferSizeTemp;
                    this.dataPos = v15 + 8;
                    return 1;
                }

                const v16 = v15 + bufferSizeTemp;
                v7 = v16 < v5;
                this.dataPos = v16;
                this.headerPos = v16;

            } while (v7);
        }

        return 0;
    }

    // Traducción de: char __thiscall vtFFChunk::FindNext(vtFFChunk *this, char *Str2)
    findNext(str2) {
        if (this.chunkSize === 0) {
            throw new Error("Chunk no valido para FindNext"); // Equivalente a CxxThrowException
        }

        this.flush();
        const parent_chunk = this.parentChunk;
        let v5;

        if (parent_chunk !== null && parent_chunk !== undefined) {
            v5 = parent_chunk.chunkSize + parent_chunk.headerPos;
        } else {
            v5 = this.streamPtr.bufferSize;
        }

        const v6 = this.chunkSize + this.headerPos;
        this.headerPos = v6;
        this.dataPos = v6;
        this.chunkSize = 0;

        if (v6 < v5) {
            do {
                const header_pos = this.headerPos;

                // vtFile_Read(..., chunk_id, 4u);
                const idBuffer = this.streamPtr.readAbsolute(header_pos, 4);
                this.chunkId = idBuffer.toString("ascii");

                // vtFile_Read(..., &Buffer, 4u);
                const sizeBuffer = this.streamPtr.readAbsolute(header_pos + 4, 4);
                const bufferSizeTemp = sizeBuffer.readUInt32LE(0); 

                if (bufferSizeTemp < 8 || bufferSizeTemp + this.headerPos > v5) {
                    break;
                }

                const v12 = this.chunkId === str2;
                const v13 = this.headerPos;

                if (v12) {
                    this.chunkSize = bufferSizeTemp;
                    this.dataPos = v13 + 8;
                    return 1;
                }

                const v14 = v13 + bufferSizeTemp;
                const v15 = v14 < v5;
                this.dataPos = v14;
                this.headerPos = v14;

                if (!v15) {
                    break;
                }
            } while (true);
        }

        return 0;
    }
}

// ==================================================
// TRADUCCIÓN DEL BUCLE RAÍZ: vtNFO_NFO::Read
// ==================================================
const inputFile = process.argv[2] ? `${process.argv[2]}` : './nfos/Cuchillo.NFO';
const fileBuffer = fs.readFileSync(inputFile);

const vtffStream = new VtStream(fileBuffer.length, fileBuffer);

// Este objeto simula el parámetro "a2" original de C++ que se le pasa a vtNFO_NFO::Read.
// Representa el archivo físico completo y su inicio en 0.
const fileContainer = {
    streamPtr: vtffStream,
    headerPos: 0,
    chunkSize: fileBuffer.length // Crucial para que start_pos_new_chunk no se vuelva NaN
};
// ============================================================================
// TRADUCCIÓN LITERAL DE sub_10043040 (OBJ1) EN NODE.JS
// ============================================================================
function sub_10043040(chunkParent) {
    // 1. vtFFChunk::vtFFChunk(this, a2); -> Inicializa un chunk hijo desde el padre (OBJ1)
    const v29 = new VtFFChunk(chunkParent);

    // 2. Validación: if ( v30 != *(_DWORD *)aInfo )
    if (v29.chunkId !== 'INFO') {
        throw new Error(`CHUNK no esperado: ${v29.chunkId}`);
    }

    // 3. vtFFChunk::Read x 6 (leemos 6 enteros de 32 bits de la cabecera INFO)
    const bufferCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const mtrCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const matrixCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const track1Count = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const track2Count = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const unknownVal = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;

    // 4. vtFFChunk::Read(..., Buffer + 32, 0x40u); -> Saltamos 64 bytes de padding/reservado
    v29.dataPos += 0x40;

    // Inicialización de contadores de bucle locales reflejados en C++
    let v24 = 0; // contador BOX1
    let v26 = 0; // contador LOD1
    let v28 = 0; // contador TRA1
    let v27 = 0; // contador MTR1

    // 5. if ( vtFFChunk::Next(v29) != 0 ) do { ... } while ( vtFFChunk::Next(v29) != 0 );
    while (v29.next() !== 0) {
        const chunkId = v29.chunkId;

        if (chunkId === 'CSTR') {
            // Manejado según el flujo original
        } 
        else if (chunkId === 'MTR1') {
            if (v27 < mtrCount) {
                console.log(`[OBJ1] Procesando MTR1 #${v27}`);
                // sub_100439D0(...)
                v27++;
            }
        } 
        else if (chunkId === 'TRA1') {
            if (v28 < track1Count + track2Count) {
                console.log(`[OBJ1] Procesando TRA1 (Transformación/Hueso) #${v28}`);
                
                // vtFFChunk::vtFFChunk(v33, v29);
                const v33 = new VtFFChunk(v29);
                
                // vtFFChunk::FindFirst(v33, aCstr)
                // vtFFChunk::FindFirst(v33, aInfo)
                // vtFFChunk::Read(v33, v17, 0x40u);
                // vtFFChunk::Read(v33, v17 + 16, 4u);
                
                v28++;
            }
        } 
        else if (chunkId === 'LOD1') {
            if (v26 < bufferCount) {
                console.log(`[OBJ1] Procesando LOD1 (Malla Geométrica) #${v26}`);
                sub_10043D80(v29, 'MSH1')
                v26++;
            }
        } 
        else if (chunkId === 'BOX1') {
            if (v24 < bufferCount) {
                console.log(`[OBJ1] Procesando BOX1 (Bounding Box) #${v24}`);
                // vtFFChunk::Read x 3 (4u, 4u, 0x60u)
                v24++;
            }
        } 
        else if (chunkId === 'PHY1') {
            console.log(`[OBJ1] Procesando PHY1 (Físicas)`);
            // sub_10044BB0(...)
        }
    }
}
// if ( *(_DWORD *)a2->chunk_id != *(_DWORD *)aVtff )
const magicStr = vtffStream.readAbsolute(fileContainer.headerPos, 4).toString('ascii');
if (magicStr !== 'VTFF') {
    throw new Error("El archivo no es un VTFF válido (Firma errónea).");
}

// vtFFChunk::vtFFChunk(this: &v50, a2);
const v50 = new VtFFChunk(fileContainer);

// if ( *(_DWORD *)v50.chunk_id != *(_DWORD *)aInfo )
if (v50.chunkId !== 'INFO') {
    throw new Error(`CHUNK no esperado: ${v50.chunkId}`);
}

console.log("¡Cabecera INFO y VTFF verificadas correctamente!");

// while ( vtFFChunk::Next(this: &v50) != 0 )
while (v50.next() !== 0) {
    console.log(`[RAÍZ] Identificado Chunk: ${v50.chunkId} | Tamaño reservado: ${v50.chunkSize} bytes`);
    
    if (v50.chunkId === 'OBJ1') {
        console.log(">>> Entrando a sub_10043040(v50) ...");
        sub_10043040(v50)
        // Aquí llamarás a tu implementación de sub_10043040 pasando 'v50'
    }
}


// Traducción de: void __thiscall sub_10043D80(char *Buffer, struct vtFFChunk *a2)
function sub_10043D80(a2, Str2 = 'STP1') {
    // vtFFChunk::vtFFChunk(this: (vtFFChunk *)v10, a2);
    const v10 = new VtFFChunk(a2);

    // if ( !vtFFChunk::FindFirst(this: (vtFFChunk *)v10, a2: aInfo) )
    if (v10.findFirst('INFO') === 0) {
        throw new Error("CHUNK INFO NO ENCONTRADO EN MSH1 (Exception 558)");
    }

    // vtFFChunk::Read(this: (vtFFChunk *)v10, Buffer, ElementSize: 4u);
    const buffer0 = v10.streamPtr.readAbsolute(v10.dataPos, 4).readUInt32LE(0);
    v10.dataPos += 4;

    // vtFFChunk::Read(this: (vtFFChunk *)v10, Buffer: Buffer + 4, ElementSize: 4u);
    const buffer1 = v10.streamPtr.readAbsolute(v10.dataPos, 4).readUInt32LE(0);
    v10.dataPos += 4;

    // v5 = *((_DWORD *)Buffer + 1); 
    const v5 = buffer1;

    // v7 = 0; v8 = *v4 <= 0;
    let v7 = 0;
    const v8 = buffer1 <= 0;

    if (!v8) {
        do {
            let nextResult;
            
            // if ( v7 != 0 ) Next = vtFFChunk::FindNext(...) else Next = vtFFChunk::FindFirst(...)
            if (v7 !== 0) {
                nextResult = v10.findNext(Str2);
            } else {
                nextResult = v10.findFirst(Str2);
            }

            // if ( !Next )
            if (nextResult === 0) {
                throw new Error("CHUNK MSH1 NO ENCONTRADO (Exception 572)");
            }

            // sub_100441F0(Buffer: (void *)(*((_DWORD *)Buffer + 2) + 104 * v7++), a2: (struct vtFFChunk *)v10);
            const mockMeshBuffers = new Array(v5).fill(null).map(() => ({}));
            console.log(`[LOD1 -> MSH1] Fragmento extraído: ${v10.chunkId}, iteración: ${v7}. Llamando a sub_100441F0...`);
            sub_100441F0(mockMeshBuffers, v10); // Llamada a la función que extrae los vértices finales
            console.log("buffer1 ", buffer1)

            v7++;
        } while (v7 < buffer1);
    }
}
// ============================================================================
// STUBS DE FUNCIONES EXTERNAS (Para que el código se ejecute sin errores)
// ============================================================================

// Lee los metadatos de INFO en MSH1 y rellena Buffer[7], Buffer[8], Buffer[9]
// ============================================================================
// TRADUCCIÓN LITERAL DE sub_10043F10 (Lector de Cabecera y Streams de MSH1 -> INFO)
// ============================================================================

function sub_10043F10(meshBuffer, a2) {
    // a2 es una instancia de VtFFChunk posicionado en el chunk 'INFO' de MSH1.
    // meshBuffer simula el puntero Buffer de C++ (donde cada índice es un DWORD de 4 bytes).

    // 1. 10 lecturas consecutivas de 4 bytes (de Buffer + 0 hasta Buffer + 36)
    for (let i = 0; i < 10; i++) {
        meshBuffer[i] = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0);
        a2.dataPos += 4;
    }

    // A partir de aquí, los índices en meshBuffer corresponden a:
    // meshBuffer[3] = Cantidad de elementos del Stream 1 (ej. Vértices)
    // meshBuffer[4] = Cantidad de elementos del Stream 2
    // meshBuffer[5] = Cantidad de elementos del Stream 3
    // meshBuffer[6] = Cantidad de elementos generales / índices de caras

    // 2. v3 = operator new(a1: 12 * *((_DWORD *)Buffer + 3)); ... *((_DWORD *)Buffer + 10) = v3;
    const size3 = 12 * (meshBuffer[3] || 0);
    if (size3 > 0) {
        //geometry
        meshBuffer[10] = a2.streamPtr.readAbsolute(a2.dataPos, size3);
        exportObj.vertex.push(meshBuffer[10])
        if(exportObj.is_touch){
            exportXYZBufferToOBJ(exportObj)
            exportObj.is_touch = false
        }else{
            exportObj.is_touch = true
        }
        
        a2.dataPos += size3;
    } else {
        meshBuffer[10] = null;
    }

    // 3. v4 = malloc(Size: 8 * *((_DWORD *)Buffer + 4)); ... *((_DWORD *)Buffer + 11) = v4;
    const size4 = 8 * (meshBuffer[4] || 0);
    if (size4 > 0) {
        meshBuffer[11] = a2.streamPtr.readAbsolute(a2.dataPos, size4);
        a2.dataPos += size4;
    } else {
        meshBuffer[11] = null;
    }

    // 4. v5 = operator new(a1: 12 * *((_DWORD *)Buffer + 5)); ... *((_DWORD *)Buffer + 12) = v5;
    const size5 = 12 * (meshBuffer[5] || 0);
    if (size5 > 0) {
        meshBuffer[12] = a2.streamPtr.readAbsolute(a2.dataPos, size5);
        a2.dataPos += size5;
    } else {
        meshBuffer[12] = null;
    }

    // 5. v6 = malloc(Size: 4 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 13) = v6;
    const size6_1 = 4 * (meshBuffer[6] || 0);
    if (size6_1 > 0) {
        meshBuffer[13] = a2.streamPtr.readAbsolute(a2.dataPos, size6_1);
        a2.dataPos += size6_1;
    } else {
        meshBuffer[13] = null;
    }

    // 6. v7 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 14) = v7;
    const size6_2 = 12 * (meshBuffer[6] || 0);
    if (size6_2 > 0) {
        meshBuffer[14] = a2.streamPtr.readAbsolute(a2.dataPos, size6_2);
        exportObj.faces.push(meshBuffer[14])
        if(exportObj.is_touch){
            exportXYZBufferToOBJ(exportObj)
            exportObj.is_touch = false
        }else{
            exportObj.is_touch = true
        }
        a2.dataPos += size6_2;
    } else {
        meshBuffer[14] = null;
    }

    // 7. v8 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 15) = v8;
    const size6_3 = 12 * (meshBuffer[6] || 0);
    if (size6_3 > 0) {
        meshBuffer[15] = a2.streamPtr.readAbsolute(a2.dataPos, size6_3);
        a2.dataPos += size6_3;
    } else {
        meshBuffer[15] = null;
    }

    // 8. v9 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 16) = v9;
    const size6_4 = 12 * (meshBuffer[6] || 0);
    if (size6_4 > 0) {
        meshBuffer[16] = a2.streamPtr.readAbsolute(a2.dataPos, size6_4);
        a2.dataPos += size6_4;
    } else {
        meshBuffer[16] = null;
    }

    // 9. vtFFChunk::Read(this: a2, Buffer: Buffer + 68, ElementSize: 0xCu);
    // Nota: Buffer + 68 bytes equivale al índice aritmético [17] en un array de DWORDs (17 * 4 = 68).
    // Leemos 12 bytes (0xCu).
    meshBuffer[17] = a2.streamPtr.readAbsolute(a2.dataPos, 12);
    a2.dataPos += 12;

    // 10. vtFFChunk::Read(this: a2, Buffer: Buffer + 80, ElementSize: 0xCu);
    // Buffer + 80 bytes equivale al índice aritmético [20] (20 * 4 = 80).
    // Leemos 12 bytes y retornamos el resultado de la lectura.
    meshBuffer[20] = a2.streamPtr.readAbsolute(a2.dataPos, 12);
    a2.dataPos += 12;

    return 1; // Equivalente al retorno exitoso de vtFFChunk::Read
}

// Procesa el chunk ZMR1
function sub_10044B40(zmrEntry, chunk) {
    console.log(`[MSH1] Llamada a sub_10044B40(ZMR1).`);
}
function exportXYZBufferToOBJ(exportObj) {
    const counter = exportObj.counter
    const xyzBuffer = exportObj.vertex[counter]
    const facesBuffer = exportObj.faces[counter]
   
    let objContent = `# Exportado desde Buffer XYZ crudo\n`;
    objContent += `g MallaCuchillo\n\n`;

    const VERTEX_STRIDE = 12; // 3 floats x 4 bytes cada uno (X, Y, Z)
    const vertexCount = Math.floor(xyzBuffer.length / VERTEX_STRIDE);

    console.log(`\n📦 Procesando Buffer XYZ: ${xyzBuffer.length} bytes -> ~${vertexCount} vértices detectados.`);

    let validVertices = 0;

    for (let i = 0; i < vertexCount; i++) {
        const offset = i * VERTEX_STRIDE;

        // Leer los 3 floats de 32 bits en Little Endian
        const x = xyzBuffer.readFloatLE(offset);
        const y = xyzBuffer.readFloatLE(offset + 4);
        const z = xyzBuffer.readFloatLE(offset + 8);

        // Validación básica de seguridad para descartar ruido o paddings nulos
        if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            objContent += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
            validVertices++;
        }
    }
    // Nota: Como este buffer contiene únicamente los puntos (vértices) de los STP1 
    // sin la lista directa de caras ZTR1 en este fragmento, generamos una nube de puntos 
    // o puedes conectar las caras si ya dispones de los índices.
    // Para ver los vértices como puntos en el OBJ, añadimos un bloque "p":
    objContent += `\n# Nube de vértices\np `;
    for (let i = 1; i <= validVertices; i++) {
        objContent += `${i} `;
    }
    objContent += `\n`;
    // 2. Procesar Caras / Índices
    const indices = [];
    let cursor = 0;

    while (cursor < facesBuffer.length) {
        let idx = 0;
        if (32 === 32) {
            if (cursor + 4 > facesBuffer.length) break;
            idx = facesBuffer.readUInt32LE(cursor);
            cursor += 4;
        } else {
            if (cursor + 2 > facesBuffer.length) break;
            idx = facesBuffer.readUInt16LE(cursor);
            cursor += 2;
        }
        indices.push(idx);
    }

    console.log(`📦 Procesando Caras: ${facesBuffer.length} bytes -> ${indices.length} índices leídos.`);

    // 3. Escribir las caras en formato OBJ (agrupadas de 3 en 3, adaptadas a base 1)
    objContent += `usemtl DefaultMaterial\n`;
    let faceCount = 0;

    for (let i = 0; i + 2 < indices.length; i += 3) {
        const i1 = indices[i] + 1;
        const i2 = indices[i + 1] + 1;
        const i3 = indices[i + 2] + 1;

        // Validar que los índices estén dentro del rango de vértices cargados
        if (i1 <= vertexCount && i2 <= vertexCount && i3 <= vertexCount) {
            if (i1 !== i2 && i2 !== i3 && i1 !== i3) {
                objContent += `f ${i1} ${i2} ${i3}\n`;
                faceCount++;
            }
        }
    }


    const outputFilePath = fs.writeFileSync(process.argv[2] ? `${process.argv[2].replace(".NFO", `_${counter}.obj`)}` : './nfos/Cuchillo.obj', objContent);
    exportObj.counter = exportObj.counter + 1
    console.log(`✅ Archivo .obj generado con éxito en: ${outputFilePath}`);
    console.log(`   - Vértices escritos: ${validVertices}`);
}
// ============================================================================
// TRADUCCIÓN LITERAL DE sub_100441F0 (Procesador de MSH1)
// ============================================================================
function sub_100441F0(meshBuffer, a2) {
    // 1. vtFFChunk::vtFFChunk(this: (vtFFChunk *)v25, a2);
    const v25 = new VtFFChunk(a2);

    let v3 = 0; // Contador de STP1 / STP2
    
    // 2. if ( *(_DWORD *)v26 != *(_DWORD *)aInfo )
    if (v25.chunkId !== 'INFO') {
        throw new Error(`CHUNK no esperado: ${v25.chunkId} (Exception 673)`);
    }

    // 3. sub_10043F10(Buffer, a2: (vtFFChunk *)v25);
    sub_10043F10(meshBuffer, v25);
    
    // 4. v4 = *((_DWORD *)Buffer + 7);
    const v4 = meshBuffer[7] || 0;
    if (v4 !== 0) {
        // *((_DWORD *)Buffer + 23) = malloc(Size: 4 * v4);
        meshBuffer[23] = new Array(v4).fill(null);
    } else {
        meshBuffer[23] = null;
    }

    // 5. v5 = *((_DWORD *)Buffer + 8);
    const v5 = meshBuffer[8] || 0;
    if (v5 !== 0) {
        // v6 = operator new(a1: 20 * v5 + 4); ... *((_DWORD *)Buffer + 24) = v6 + 1;
        // Creamos un array de objetos para estructurar los 20 bytes (5 DWORDs) de ZTR1
        meshBuffer[24] = new Array(v5).fill(null).map(() => ({
            val0: 0,
            val1_count: 0,
            val2_ptr: null,
            val3: 0,
            val4_ptr: null
        }));
    } else {
        meshBuffer[24] = null;
    }

    // 6. v7 = *((_DWORD *)Buffer + 9);
    const v7 = meshBuffer[9] || 0;
    if (v7 !== 0) {
        // v8 = operator new(a1: 16 * v7 + 4); ... *((_DWORD *)Buffer + 25) = v8 + 1;
        meshBuffer[25] = new Array(v7).fill(null).map(() => ({})); // Array para ZMR1
    } else {
        meshBuffer[25] = null;
    }

    let v9 = 0;   // Contador ZMR1
    let v23 = 0;  // Copia contador ZMR1
    let v20 = 0;  // Contador ZTR1
    let v22 = 0;  // Copia contador STP1/STP2

    // 7. while ( vtFFChunk::Next(this: (vtFFChunk *)v25) != 0 )
    if (v25.next() !== 0) {
        let v24 = 0; // Índice ZMR1 (Offset de bytes simulado en array)
        let v21 = 0; // Índice ZTR1 (Offset de bytes simulado en array)

        do {
            const chunkId = v25.chunkId;

            // if ( *(_DWORD *)v26 == *(_DWORD *)aStp1 && v3 < *((_DWORD *)Buffer + 7) )
            if (chunkId === 'STP1' && v3 < meshBuffer[7]) {
                console.log(`[MSH1] Extrayendo STP1 #${v3}`);
                // En C++ aquí hace llamadas a funciones virtuales `(**v11)(...)`
                // Lo simulamos instanciando el objeto de array asignado.
                meshBuffer[23][v3] = { type: 'STP1', chunkData: v25 };
                
                v3++;
                v22 = v3;
            }
            
            // if ( *(_DWORD *)v26 == *(_DWORD *)aStp2 && v3 < *((_DWORD *)Buffer + 7) )
            if (chunkId === 'STP2' && v3 < meshBuffer[7]) {
                console.log(`[MSH1] Extrayendo STP2 #${v3}`);
                meshBuffer[23][v3] = { type: 'STP2', chunkData: v25 };
                
                v3++;
                v22 = v3;
            }
            
            // else if ( *(_DWORD *)v26 == *(_DWORD *)aZtr1 && v20 < *((_DWORD *)Buffer + 8) )
            else if (chunkId === 'ZTR1' && v20 < meshBuffer[8]) {
                console.log(`[MSH1] Extrayendo ZTR1 #${v20}`);
                
                // v14 = (_DWORD *)(v21 + *((_DWORD *)Buffer + 24));
                const v14 = meshBuffer[24][v20];

                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v14, ElementSize: 4u);
                v14.val0 = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                v25.dataPos += 4;

                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v14 + 1, ElementSize: 4u);
                v14.val1_count = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                v25.dataPos += 4;

                // v16 = malloc(Size: 4 * v14[1]);
                // v14[2] = v16;
                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v16, ElementSize: v18);
                const bytesToRead = 4 * v14.val1_count;
                v14.val2_ptr = v25.streamPtr.readAbsolute(v25.dataPos, bytesToRead);
                v25.dataPos += bytesToRead;

                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v14 + 3, ElementSize: 4u);
                v14.val3 = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                v25.dataPos += 4;

                // if ( v14[3] != 0 )
                if (v14.val3 !== 0) {
                    // v17 = malloc(Size: 4 * *v15); // NOTA: *v15 es v14[1] en la estructura original
                    // v14[4] = v17;
                    // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v17, ElementSize: v19);
                    const extraBytes = 4 * v14.val1_count;
                    v14.val4_ptr = v25.streamPtr.readAbsolute(v25.dataPos, extraBytes);
                    v25.dataPos += extraBytes;
                } else {
                    v14.val4_ptr = null;
                }

                v3 = v22;
                v9 = v23;
                v20++;
                v21 += 20; // Avanza el tamaño del struct de ZTR1
            }
            
            // else if ( *(_DWORD *)v26 == *(_DWORD *)aZmr1 && v9 < *((_DWORD *)Buffer + 9) )
            else if (chunkId === 'ZMR1' && v9 < meshBuffer[9]) {
                console.log(`[MSH1] Extrayendo ZMR1 #${v9}`);
                // sub_10044B40(Buffer: (void *)(v24 + *((_DWORD *)Buffer + 25)), a2: (vtFFChunk *)v25);
                sub_10044B40(meshBuffer[25][v9], v25);
                
                v9++;
                v23 = v9;
                v24 += 16; // Avanza el tamaño del struct de ZMR1
            }

        } while (v25.next() !== 0);
    }

    // 8. if ( v3 != *((_DWORD *)Buffer + 7) || v20 != *((_DWORD *)Buffer + 8) || v9 != *((_DWORD *)Buffer + 9) )
    if (v3 !== meshBuffer[7] || v20 !== meshBuffer[8] || v9 !== meshBuffer[9]) {
        throw new Error("Datos de MSH1 incorrectos: La cantidad de sub-chunks no coincide con el INFO de cabecera. (Exception 723)");
    }

    console.log(`[MSH1] Chunk procesado con éxito.`);
}
