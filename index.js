const fs = require('fs');
let exportObj = {
    vertex: [],
    faces: [],
    bones: [],
    is_touch: false,
    counter: 0
}
const AXIS_MATRICES = {
    none: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ],

    // rotate +90 about X: source Z-up -> glTF Y-up
    z_up_to_y_up: [
        [1, 0,  0, 0],
        [0, 0, -1, 0],
        [0, 1,  0, 0],
        [0, 0,  0, 1]
    ]
};
const exportsArr = [];
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

function parseMaterials(v29){
    console.log("v29: ", v29)
    
    const cstr = new VtFFChunk(v29)
    // 2. Validación: if ( v30 != *(_DWORD *)aInfo )
    if (cstr.chunkId !== 'CSTR') {
        throw new Error(`CHUNK no esperado: ${v29.chunkId}`);
    }
    const buffName = cstr.streamPtr.readAbsolute(cstr.dataPos, cstr.chunkSize - 8);
    const name = buffName.toString('ascii')
    let texture
    cstr.dataPos += cstr.chunkSize - 8;
    if(!cstr.findFirst('INFO')){
        throw new Error(`CHUNK no esperado: ${v29.chunkId}`);
    }
    console.log("cstr: ", cstr)
    const buf = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf1 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf2 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf3 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf4 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf5 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    const buf6 = cstr.streamPtr.readAbsolute(cstr.dataPos, 4);
    cstr.dataPos += 4
    let i = 0;
    while(i  < buf6.readInt32LE()){
        console.log('follow: ', i)
        
        if(cstr.next() == 0){
            break;
        }
        if(cstr.chunkId === 'CSTR'){
            console.log('follow2: ', cstr.chunkId)
            const bufNameMaterial = cstr.streamPtr.readAbsolute(cstr.dataPos, cstr.chunkSize-8)
            cstr.dataPos += cstr.chunkSize-8
            console.log('bufNameMaterial: ', bufNameMaterial.toString('ascii'))
            texture = bufNameMaterial.toString('ascii')
            i++
        }
        
    }
    const diffuse = [255, 255, 255, 255];
    const shininess = 0.0
    const secondary = diffuse
    const tertiary = diffuse
    return {texture, name, shininess, secondaryRgba: secondary, tertiaryRgba: tertiary, diffuseRgba: diffuse }
}
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
    
    const materialCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const boneCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;
    
    const meshCount = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
    v29.dataPos += 4;

    // 4. vtFFChunk::Read(..., Buffer + 32, 0x40u); -> Saltamos 64 bytes de padding/reservado
    v29.dataPos += 0x40;

    // Inicialización de contadores de bucle locales reflejados en C++
    let v24 = 0; // contador BOX1
    let v26 = 0; // contador LOD1
    let v28 = 0; // contador TRA1
    let v27 = 0; // contador MTR1

    let v14 = 0; // Aritmética de punteros para TRA1 (equivale a v14 += 96 en C++)  
    // 5. if ( vtFFChunk::Next(v29) != 0 ) do { ... } while ( vtFFChunk::Next(v29) != 0 );
    const lodsArr = []
    const bonesArr = []
    const materials = []
    while (v29.next() !== 0) {
        const chunkId = v29.chunkId;

        if (chunkId === 'CSTR') {
            // Manejado según el flujo original

        } 
        else if (chunkId === 'MTR1') {
            console.log(`[OBJ1] SubProcesando MTR1 #${v27}`);
            if (v27 < mtrCount) {
                // sub_100439D0(...)
                materials.push(parseMaterials(v29))
                v27++;
            }
        } 
        else if (chunkId === 'TRA1') {
            if (v28 < materialCount + boneCount) {
                console.log(`[OBJ1] SubProcesando TRA1 (Transformación/Hueso) #${v28}`);
// if ( v28 < *((_DWORD *)Buffer + 4) + *((_DWORD *)Buffer + 5) )

                // vtFFChunk::vtFFChunk(this: (vtFFChunk *)v33, a2: (struct vtFFChunk *)v29);
                const v33 = new VtFFChunk(v29);

                // Simulación del puntero de estructura TRA1 en memoria
                const v17 = { data: Buffer.alloc(100), 20: null };

                // if ( vtFFChunk::FindFirst(this: (vtFFChunk *)v33, a2: aCstr) )
                if (v33.findFirst('CSTR') === 1) {
                    const cstrSize = v33.chunkSize - 8;
                    const v18 = v33.streamPtr.readAbsolute(v33.dataPos, cstrSize);
                    v17[20] = v18; // v17[20] = v18;

                    console.log("nombre hueso: ", v18.toString('ascii'))

                    // vtFFChunk::Read(this: (vtFFChunk *)v33, Buffer: v18, a3: v22); (Ya leído mediante readAbsolute)
                } else {
                    v17[20] = 0;
                }

                // if ( !vtFFChunk::FindFirst(this: (vtFFChunk *)v33, a2: aInfo) )
                if (v33.findFirst('INFO') === 0) {
                    throw new Error("CHUNK INFO NO ENCONTRADO EN TRA1 (Exception 523)");
                }

                // vtFFChunk::Read(this: (vtFFChunk *)v33, Buffer: v17, a3: 0x40u);
                const trMatrixData = v33.streamPtr.readAbsolute(v33.dataPos, 0x40);

                    
                v33.dataPos += 0x40;
                

                // vtFFChunk::Read(this: (vtFFChunk *)v33, Buffer: v17 + 16, a3: 4u);
                const parentId = v33.streamPtr.readAbsolute(v33.dataPos, 4).readUInt32LE(0);
                v33.dataPos += 0x04;
                console.log("parentId", parentId)
                let row = []
                const result = []
                for (let i = 0; i < trMatrixData.length / 4; i++) {
                    
                    row.push(trMatrixData.readFloatLE(i * 4));
                    if(row.length >= 3){
                        result.push(row)
                        row = []
                        console.log("trMatrixData.readFloatLE(i * 4)",result)
                    }
                    
                }
                bonesArr.push({
                    nameBone: v17[20].toString('ascii'),
                    matrix: trMatrixData,
                    parentId: parentId === 0xFFFFFFFF ? -1 : parentId
                })

                exportObj.bones.push({
                    nameBone: v17[20].toString('ascii'),
                    matrix: trMatrixData,
                    parentId: parentId === 0xFFFFFFFF ? -1 : parentId
                })   
                console.log("bones_matrix: ", trMatrixData.toString('hex'))
                v33.dataPos += 4;

                v14 += 96;
                v28++;
            
            }
        } 
        else if (chunkId === 'LOD1') {
            if (v26 < bufferCount) {
                console.log(`[OBJ1] SubProcesando LOD1 (Malla Geométrica) #${v26}`);
                const lodRow = sub_10043D80(v29, 'MSH1',lodsArr.length)
                lodsArr.push(lodRow)
                v26++;
            }
        } 
        else if (chunkId === 'BOX1') {
            if (v24 < bufferCount) {
                if (!exportObj.boxes) exportObj.boxes = [];
                
                const boxData = {};
                
                // vtFFChunk::Read(this: (vtFFChunk *)v29, Buffer: (void *)v19, a3: 4u);
                boxData.val0 = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
                v29.dataPos += 4;
                
                // vtFFChunk::Read(this: (vtFFChunk *)v29, Buffer: (void *)(v19 + 4), a3: 4u);
                boxData.val1 = v29.streamPtr.readAbsolute(v29.dataPos, 4).readUInt32LE(0);
                v29.dataPos += 4;
                
                // vtFFChunk::Read(this: (vtFFChunk *)v29, Buffer: (void *)(v19 + 8), a3: 0x60u);
                // 96 bytes = 24 floats
                boxData.buffer96 = v29.streamPtr.readAbsolute(v29.dataPos, 0x60);
                v29.dataPos += 0x60;
                
                exportObj.boxes.push(boxData);
                
                console.log(`[OBJ1] SubProcesando BOX1 #${v24} | val0: ${boxData.val0}, val1: ${boxData.val1}`);
                
                // Vamos a imprimir los floats del PRIMER elemento para ver qué demonios hay dentro
                if (v24 === 0) {

                }
                
                v24++;
            }
        } 
        else if (chunkId === 'PHY1') {
            console.log(`[OBJ1] SubProcesando PHY1 (Físicas)`);
            
            // Creamos un objeto para almacenar el resultado y lo asignamos al exportObj principal
            const phyBuffer = {};
            exportObj.phyData = phyBuffer;

            // Llamada estricta replicando: sub_10044BB0(Buffer: v20, a2: (struct vtFFChunk *)v29);
            sub_10044BB0(phyBuffer, v29);
        }
       
    }
    const meshes = []
    
    for(let i = 0; i < lodsArr.length; i++){
        let meshOrder = 0
        for(let x = 0; x < lodsArr[i].length; x++){
            
            let mesh = {
                lodIndex: i,
                nodeIdx: lodsArr[i][x].nodeIdx,
                positions: lodsArr[i][x].positions,
                skinGroups: lodsArr[i][x].skinGroups,
                idxPos: lodsArr[i][x].idxPos,
                materialsId: lodsArr[i][x].materialsId,
                idxUv: lodsArr[i][x].idxUv,
                idxNormal: lodsArr[i][x].idxNormal,
                uvs: lodsArr[i][x].uvs,
                normals: lodsArr[i][x].normals,
            }
            console.log("mesh.nodeIdx: ", mesh.nodeIdx)
            if (mesh.nodeIdx < bonesArr.length){
                mesh.name = bonesArr[mesh.nodeIdx].nameBone
            }else{
                mesh.name = `mesh_lod${i}_${meshOrder}`
            }
            
            meshes.push(mesh)
            meshOrder+=1
            console.log("mesh name: ", mesh.name)
        }

    }
    return {meshes: meshes, bonesArr: bonesArr, materialCount: materialCount, boneCount: boneCount, meshCount: meshCount, materials: materials}
}

// ============================================================================
// TRADUCCIÓN LITERAL DE sub_10044BB0 (Procesador de PHY1)
// ============================================================================
function sub_10044BB0(phyBuffer, a2) {
    // vtFFChunk::vtFFChunk(this: (vtFFChunk *)v16, a2);
    const v16 = new VtFFChunk(a2);

    let v13 = 0; // Contador JNT1
    let v14 = 0; // Contador LNK1

    // if ( v16[3] != *(_DWORD *)aInfo )
    if (v16.chunkId !== 'INFO') {
        throw new Error("CHUNK INFO NO ENCONTRADO EN PHY1 (Exception 922)");
    }

    // vtFFChunk::Read(..., Buffer, 4u);
    phyBuffer.numJnt = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); 
    v16.dataPos += 4;

    // vtFFChunk::Read(..., Buffer + 4, 4u);
    phyBuffer.numLnk = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); 
    v16.dataPos += 4;

    // vtFFChunk::Read(..., Buffer + 8, 4u);
    phyBuffer.unkCount1 = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); 
    v16.dataPos += 4;

    // vtFFChunk::Read(..., Buffer + 12, 4u);
    phyBuffer.unkCount2 = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); 
    v16.dataPos += 4;

    // v5 = malloc(Size: 4 * *((_DWORD *)Buffer + 2)); ... vtFFChunk::Read(..., v5, v11);
    const sizeUnk = 4 * phyBuffer.unkCount1;
    if (sizeUnk > 0) {
        phyBuffer.unkData = v16.streamPtr.readAbsolute(v16.dataPos, sizeUnk);
        v16.dataPos += sizeUnk;
    } else {
        phyBuffer.unkData = null;
    }

    // *((_DWORD *)Buffer + 5) = operator new(a1: 20 * *(_DWORD *)Buffer + 4);
    // Reservamos el array de 20 bytes por elemento (JNT1)
    phyBuffer.joints = new Array(phyBuffer.numJnt).fill(null).map(() => ({}));

    // *((_DWORD *)Buffer + 6) = operator new(a1: 52 * *v4);
    // Reservamos el array de 52 bytes por elemento (LNK1)
    phyBuffer.links = new Array(phyBuffer.numLnk).fill(null).map(() => ({}));

    // if ( vtFFChunk::Next(this: (vtFFChunk *)v16) != 0 )
    if (v16.next() !== 0) {
        do {
            const chunkId = v16.chunkId;

            // if ( v16[3] == *(_DWORD *)aJnt1 && v13 < *(_DWORD *)Buffer )
            if (chunkId === 'JNT1' && v13 < phyBuffer.numJnt) {
                const jnt = phyBuffer.joints[v13];

                // vtFFChunk::Read(..., v8, 4u);
                jnt.val0 = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); v16.dataPos += 4;
                // vtFFChunk::Read(..., v8 + 1, 4u);
                jnt.val1 = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); v16.dataPos += 4;
                // vtFFChunk::Read(..., v8 + 2, 4u);
                jnt.val2 = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); v16.dataPos += 4;
                // vtFFChunk::Read(..., v8 + 3, 4u);
                jnt.val3_count = v16.streamPtr.readAbsolute(v16.dataPos, 4).readUInt32LE(0); v16.dataPos += 4;

                // v10 = malloc(Size: 4 * *v9); vtFFChunk::Read(..., v8, v12);
                const extraSize = 4 * jnt.val3_count;
                if (extraSize > 0) {
                    jnt.extraData = v16.streamPtr.readAbsolute(v16.dataPos, extraSize);
                    v16.dataPos += extraSize;
                } else {
                    jnt.extraData = null;
                }

                console.log(`[PHY1] Extrayendo JNT1 #${v13}`);
                v13++;
            }
            // else if ( v16[3] == *(_DWORD *)aLnk1 && v14 < *v4 )
            else if (chunkId === 'LNK1' && v14 < phyBuffer.numLnk) {
                console.log(`[PHY1] Extrayendo LNK1 #${v14}`);
                // sub_10044FA0(Buffer: (void *)(v15 + *((_DWORD *)Buffer + 6)), a2: (vtFFChunk *)v16);
                sub_10044FA0(phyBuffer.links[v14], v16);
                v14++;
            }
        } while (v16.next() !== 0);
    }

    // if ( v13 != *(_DWORD *)Buffer || v14 != *v4 )
    if (v13 !== phyBuffer.numJnt || v14 !== phyBuffer.numLnk) {
        throw new Error("Datos PHY1 incompletos (Exception 950)");
    }

    console.log(`[PHY1] Físicas procesadas: ${v13} Joints, ${v14} Links.`);
}

// ============================================================================
// TRADUCCIÓN LITERAL DE sub_10044FA0 (Procesador de LNK1)
// ============================================================================
function sub_10044FA0(linkObj, a2) {
    // vtFFChunk::Read(this: a2, Buffer, ElementSize: 4u);
    linkObj.val0 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 4, ElementSize: 4u);
    linkObj.val1 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 8, ElementSize: 4u);
    linkObj.val2 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 12, ElementSize: 4u);
    linkObj.val3 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 16, ElementSize: 4u);
    linkObj.val4 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 20, ElementSize: 8u);
    linkObj.buffer8 = a2.streamPtr.readAbsolute(a2.dataPos, 8); a2.dataPos += 8;
    
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 28, ElementSize: 4u);
    linkObj.val5 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 32, ElementSize: 0xCu);
    linkObj.buffer12 = a2.streamPtr.readAbsolute(a2.dataPos, 12); a2.dataPos += 12;
    
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 44, ElementSize: 4u);
    linkObj.val6 = a2.streamPtr.readAbsolute(a2.dataPos, 4).readUInt32LE(0); a2.dataPos += 4;
    
    // vtFFChunk::Read(this: a2, Buffer: Buffer + 48, ElementSize: 1u);
    linkObj.val7 = a2.streamPtr.readAbsolute(a2.dataPos, 1).readUInt8(0); a2.dataPos += 1;

    return 1;
}
// Traducción de: void __thiscall sub_10043D80(char *Buffer, struct vtFFChunk *a2)
function sub_10043D80(a2, Str2 = 'STP1', idx) {
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
    const result = []
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
            const subTemp = sub_100441F0(mockMeshBuffers, v10); // Llamada a la función que extrae los vértices finales
            exportObj.skinGroups = subTemp.skinGroups
            exportObj.materialsId = subTemp.materialsId
            exportsArr.push(exportObj)
            result.push(exportObj)
            exportObj={
                vertex: [],
                faces: [],
                bones: [],
                is_touch: false,
                counter: 0
            }


            v7++;
        } while (v7 < buffer1);
        return result
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
    if(!exportObj.nodeIdx){
        exportObj.nodeIdx = meshBuffer[1]
    }
    console.log("exportObj.nodeIdx", exportObj.nodeIdx)
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
        if (!exportObj.positions) exportObj.positions = [];
        let row = []
        for (let i = 0; i < meshBuffer[10].length / 4; i++) {
            row.push(meshBuffer[10].readFloatLE(i * 4));
            if(row.length >= 3){
                exportObj.positions.push(row)
                row = []
            }
            
        }
        
        a2.dataPos += size3;
    } else {
        meshBuffer[10] = null;
    }

    // 3. Stream 2 (8 bytes por elemento ->  UVs)
    const size4 = 8 * (meshBuffer[4] || 0);
    if (size4 > 0) {
        meshBuffer[11] = a2.streamPtr.readAbsolute(a2.dataPos, size4);
        if (!exportObj.stream2) exportObj.stream2 = [];
        if (!exportObj.uvs) exportObj.uvs = [];
        exportObj.stream2.push(meshBuffer[11]);
        console.log('meshBuffer[11]  UVs):  ', meshBuffer[11])
        let row = []
        for (let i = 0; i < meshBuffer[11].length / 4; i++) {
            row.push(meshBuffer[11].readFloatLE(i * 4));
            if(row.length >= 2){
                exportObj.uvs.push(row)
                row = []
            }
            
        }
        a2.dataPos += size4;
    } else {
        meshBuffer[11] = null;
    }

    // 4. Stream 3 (12 bytes por elemento -> Probables normales)
    const size5 = 12 * (meshBuffer[5] || 0);
    if (size5 > 0) {
        meshBuffer[12] = a2.streamPtr.readAbsolute(a2.dataPos, size5);
        if (!exportObj.stream3) exportObj.stream3 = [];
        exportObj.stream3.push(meshBuffer[12]);
         console.log('meshBuffer[12]  Probables normales: ', meshBuffer[12])
        if (!exportObj.normals) exportObj.normals = [];
        let row = []
        for (let i = 0; i < meshBuffer[12].length / 4; i++) {
            row.push(meshBuffer[12].readFloatLE(i * 4));
            if(row.length >= 3){
                exportObj.normals.push(row)
                row = []
            }
            
        }
        a2.dataPos += size5;
    } else {
        meshBuffer[12] = null;
    }

    // 5. v6 = malloc(Size: 4 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 13) = v6 idMaterials;
    const size6_1 = 4 * (meshBuffer[6] || 0);
    if (size6_1 > 0) {
        meshBuffer[13] = a2.streamPtr.readAbsolute(a2.dataPos, size6_1);
        console.log("meshBuffer[13]: ", meshBuffer[13])
        console.log("meshBuffer[13].length", meshBuffer[13].length)
        if(!exportObj.materialsId){
            exportObj.materialsId = [];
        }

        for (let i = 0; i < meshBuffer[13].length / 4; i++) {
            exportObj.materialsId.push(meshBuffer[13].readInt32LE(i * 4));
        }
        a2.dataPos += size6_1;
    } else {
        meshBuffer[13] = null;
    }

    // 6. v7 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 14) = v7 idFaces;
    const size6_2 = 12 * (meshBuffer[6] || 0);
    if (size6_2 > 0) {
        meshBuffer[14] = a2.streamPtr.readAbsolute(a2.dataPos, size6_2);
        let row = []
        for (let i = 0; i < meshBuffer[14].length / 4; i++) {
            if(!exportObj.idxPos){
                exportObj.idxPos = [];
            }
            row.push(meshBuffer[14].readInt32LE(i * 4));

            if(row.length >= 3){
                exportObj.faces.push(row)
                exportObj.idxPos.push(row)
                row = []
            }
            
        }
        console.log("meshBuffer[14]: ",meshBuffer[14])
        
        a2.dataPos += size6_2;
    } else {
        meshBuffer[14] = null;
    }

    // 7. v8 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 15) = v8 idxUv;
    const size6_3 = 12 * (meshBuffer[6] || 0);
    if (size6_3 > 0) {
        meshBuffer[15] = a2.streamPtr.readAbsolute(a2.dataPos, size6_3);
        console.log("meshBuffer[15]: ", meshBuffer[15])
        if(!exportObj.idxUv){
            exportObj.idxUv = []
        }
        let row = []
        for (let i = 0; i < meshBuffer[15].length / 4; i++) {
            row.push(meshBuffer[15].readInt32LE(i * 4));
            if(row.length >= 3){
                exportObj.idxUv.push(row)
                row = []
            }
            
        }
        
        a2.dataPos += size6_3;
    } else {
        meshBuffer[15] = null;
    }

    // 8. v9 = malloc(Size: 12 * *((_DWORD *)Buffer + 6)); ... *((_DWORD *)Buffer + 16) = v9 idxNormals;
    const size6_4 = 12 * (meshBuffer[6] || 0);
    if (size6_4 > 0) {
        meshBuffer[16] = a2.streamPtr.readAbsolute(a2.dataPos, size6_4);
        console.log("meshBuffer[16]: ", meshBuffer[16])
        if(!exportObj.idxNormal){
            exportObj.idxNormal = []
        }
        let row = []
        for (let i = 0; i < meshBuffer[16].length / 4; i++) {
            row.push(meshBuffer[16].readInt32LE(i * 4));
            if(row.length >= 3){
                exportObj.idxNormal.push(row)
                row = []
            }
            
        }
        
        a2.dataPos += size6_4;
    } else {
        meshBuffer[16] = null;
    }

    // 9. vtFFChunk::Read(this: a2, Buffer: Buffer + 68, ElementSize: 0xCu);
    // Nota: Buffer + 68 bytes equivale al índice aritmético [17] en un array de DWORDs (17 * 4 = 68).
    // Leemos 12 bytes (0xCu).
    meshBuffer[17] = a2.streamPtr.readAbsolute(a2.dataPos, 12);
    if(!exportObj.bboxMin){
        exportObj.bboxMin = []
    }
    let row = []
    for (let i = 0; i < meshBuffer[17].length / 4; i++) {
        row.push(meshBuffer[17].readFloatLE(i * 4));
        if(row.length >= 3){
            exportObj.bboxMin.push(row)
            row = []
        }
        
    }
    console.log("meshBuffer[16]: ", meshBuffer[16])
    a2.dataPos += 12;

    meshBuffer[20] = a2.streamPtr.readAbsolute(a2.dataPos, 12);

    if(!exportObj.bboxMax){
        exportObj.bboxMax = []
    }
    row = []
    for (let i = 0; i < meshBuffer[20].length / 4; i++) {
        row.push(meshBuffer[20].readFloatLE(i * 4));
        if(row.length >= 3){
            exportObj.bboxMax.push(row)
            row = []
        }
        
    }
    a2.dataPos += 12;

    return exportObj; // Equivalente al retorno exitoso de vtFFChunk::Read
}

// Procesa el chunk ZMR1
function sub_10044B40(zmrEntry, chunk) {
    console.log(`[MSH1] Llamada a sub_10044B40(ZMR1).`);
}
function _boneSkinCentroids(model){
    const agg = new Map()
    console.log(" model.meshes:", model.meshes)
    for(let idx in model.meshes){
        console.log( "model.meshes[idx]: ", model.meshes[idx])
        const mesh = model.meshes[idx]
        for(let keySkin in mesh.skinGroups){
            const skin = mesh.skinGroups[keySkin]
            for(let keyVertWeight in skin.vertWeightArr){
                const vertWeight = skin.vertWeightArr[keyVertWeight]
                const vertex = vertWeight[0]
                const weight = vertWeight[1]
                if(vertex >= mesh.positions.length){
                    continue;
                }
                const pos = mesh.positions[vertex]
                let acc = agg.get(skin.boneIdx);

                if (acc === undefined) {
                    acc = [[0, 0, 0], 0.0];
                    agg.set(skin.boneIdx, acc);
                }
                console.log("mesh.boneIdx:", vertex, weight)
                acc[0][0] += pos[0] * weight;
                acc[0][1] += pos[1] * weight;
                acc[0][2] += pos[2] * weight;

                acc[1] += weight;

            }
        }
    }
    const result = new Map();

    for (const [k, v] of agg) {
        if (v[1] > 0) {
            result.set(k, [
                v[0][0] / v[1],
                v[0][1] / v[1],
                v[0][2] / v[1]
            ]);
        }
    }

    return result;
}
function computeBoneRestPositions(model){
    
    const centroIds = _boneSkinCentroids(model)
    const resolved =  new Array(model.boneCount).fill(null);
    const fallbackBones = []

    for(let i = 0; i < model.boneCount; i++){
        if(centroIds.has(i)){
            resolved[i] = [...centroIds.get(i)]
        }else{
            const parent = model.bonesArr[i].parentId
            fallbackBones.push(i)
            console.log("[computeBoneRestPositions] parent:", parent)
            if (parent < model.boneCount && resolved[parent] != null){
                resolved[i] = resolved[parent]
            }else{
                resolved[i] = [0.0, 0.0, 0.0]
            }
        }
    }

    return {resolved, fallbackBones}
}
function _boneHierarchy(model){
    const children = []

    for (let i = 0; i < model.boneCount; i++) {
        children.push([]);
    }

    for (let i = 0; i < model.boneCount; i++) {
        const p = model.bonesArr[i].parentId;

        if (p >= 0 && p < model.boneCount) {
            children[p].push(i);
        }
    }
    return children
}
function _axisDots(engineRI, direction){
    return [
        Math.abs(
            engineRI[0][0] * direction[0] +
            engineRI[1][0] * direction[1] +
            engineRI[2][0] * direction[2]
        ),
        Math.abs(
            engineRI[0][1] * direction[0] +
            engineRI[1][1] * direction[1] +
            engineRI[2][1] * direction[2]
        ),
        Math.abs(
            engineRI[0][2] * direction[0] +
            engineRI[1][2] * direction[1] +
            engineRI[2][2] * direction[2]
        )
    ];
}
function _pickReferenceChild(engineRI, realChildDirs){
    const primaryDir = realChildDirs[0]
    const primaryDots = _axisDots(engineRI, primaryDir)
    
    const order = [0, 1, 2].sort((a, b) => primaryDots[b] - primaryDots[a]);
    if (primaryDots[order[0]] - primaryDots[order[1]] > 0.15) {
        return [
            primaryDir,
            order[0],
            primaryDots[order[0]]
        ];
    }

    let bestDir = null;
    let bestK = null;
    let bestConf = -1.0;

    for (const d of realChildDirs.slice(1)) {
        const dots = _axisDots(engineRI, d);

        // np.argmax(dots)
        let k = 0;
        for (let i = 1; i < dots.length; i++) {
            if (dots[i] > dots[k]) {
                k = i;
            }
        }

        if (dots[k] > bestConf) {
            bestConf = dots[k];
            bestK = k;
            bestDir = d;
        }
    }

    if (bestDir !== null && bestConf > 0.85) {
        return [
            bestDir,
            bestK,
            bestConf
        ];
    }

    return [
        primaryDir,
        order[0],
        primaryDots[order[0]]
    ];
}
function _buildCorrectedFrame(engineRI, trueY, k){
    const ROLL_SIGN_BY_FORWARD_AXIS = {
        0: 1.0,
        1: 1.0,
        2: -1.0
    };

    const refIdx = (k + 2) % 3;

    const sign = ROLL_SIGN_BY_FORWARD_AXIS[k] ?? 1.0;

    // engine_R_i[:, ref_idx]
    const zRaw = [
        sign * engineRI[0][refIdx],
        sign * engineRI[1][refIdx],
        sign * engineRI[2][refIdx]
    ];

    // z_perp = z_raw - np.dot(z_raw, true_y) * true_y
    const dotZY =
        zRaw[0] * trueY[0] +
        zRaw[1] * trueY[1] +
        zRaw[2] * trueY[2];

    const zPerp = [
        zRaw[0] - dotZY * trueY[0],
        zRaw[1] - dotZY * trueY[1],
        zRaw[2] - dotZY * trueY[2]
    ];

    // n = np.linalg.norm(z_perp)
    let n = Math.sqrt(
        zPerp[0] * zPerp[0] +
        zPerp[1] * zPerp[1] +
        zPerp[2] * zPerp[2]
    );

    let finalZPerp = zPerp;

    if (n < 1e-8) {
        // true_y is (near-)parallel to the roll-reference axis too
        // (degenerate bone orientation) -- fall back to any perpendicular.

        const alt = Math.abs(trueY[0]) < 0.9
            ? [1.0, 0.0, 0.0]
            : [0.0, 1.0, 0.0];

        const dotAltY =
            alt[0] * trueY[0] +
            alt[1] * trueY[1] +
            alt[2] * trueY[2];

        finalZPerp = [
            alt[0] - dotAltY * trueY[0],
            alt[1] - dotAltY * trueY[1],
            alt[2] - dotAltY * trueY[2]
        ];

        n = Math.sqrt(
            finalZPerp[0] * finalZPerp[0] +
            finalZPerp[1] * finalZPerp[1] +
            finalZPerp[2] * finalZPerp[2]
        );
    }

    // z_axis = z_perp / n
    const zAxis = [
        finalZPerp[0] / n,
        finalZPerp[1] / n,
        finalZPerp[2] / n
    ];

    // x_axis = np.cross(true_y, z_axis)
    const xAxis = [
        trueY[1] * zAxis[2] - trueY[2] * zAxis[1],
        trueY[2] * zAxis[0] - trueY[0] * zAxis[2],
        trueY[0] * zAxis[1] - trueY[1] * zAxis[0]
    ];

    // np.column_stack([x_axis, true_y, z_axis])
    return [
        [xAxis[0], trueY[0], zAxis[0]],
        [xAxis[1], trueY[1], zAxis[1]],
        [xAxis[2], trueY[2], zAxis[2]]
    ];
}
function _autoCorrectBindRotations(model, rAbsolute, worldPosition, fallbackBones){
    const children = _boneHierarchy(model)
    const fallbackSet = new Set(fallbackBones);
    const corrected = new Array(model.boneCount).fill(null);
    for(let i = 0; i < model.boneCount; i++){
        const realKids = children[i].filter(
            c => {
                return !fallbackSet.has(c)}
        );
        const childDirs = []
        for(let c of realKids){
            const d = [
                worldPosition[c][0] - worldPosition[i][0],
                worldPosition[c][1] - worldPosition[i][1],
                worldPosition[c][2] - worldPosition[i][2]
            ];
            const n = Math.sqrt(
                d[0] * d[0] +
                d[1] * d[1] +
                d[2] * d[2]
            );

            if (n > 1e-6) {
                childDirs.push([
                    d[0] / n,
                    d[1] / n,
                    d[2] / n
                ]);
            }
        }
        let frame;
        if(childDirs.length > 0){
            const [trueY, k, _conf] = _pickReferenceChild(rAbsolute[i], childDirs)
     
            
            frame = _buildCorrectedFrame(rAbsolute[i], trueY, k)
            console.log("frame: ", frame)
        }
        if(!frame){
            const parent = model.bonesArr[i].parentId;

            if (
                parent >= 0 &&
                parent < model.boneCount &&
                corrected[parent] !== null
            ) {
                // relative = inv(rAbsolute[parent]) @ rAbsolute[i]

                const p = rAbsolute[parent];

                const det =
                    p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) -
                    p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) +
                    p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0]);

                const invDet = 1.0 / det;

                const invParent = [
                    [
                        (p[1][1] * p[2][2] - p[1][2] * p[2][1]) * invDet,
                        (p[0][2] * p[2][1] - p[0][1] * p[2][2]) * invDet,
                        (p[0][1] * p[1][2] - p[0][2] * p[1][1]) * invDet
                    ],
                    [
                        (p[1][2] * p[2][0] - p[1][0] * p[2][2]) * invDet,
                        (p[0][0] * p[2][2] - p[0][2] * p[2][0]) * invDet,
                        (p[0][2] * p[1][0] - p[0][0] * p[1][2]) * invDet
                    ],
                    [
                        (p[1][0] * p[2][1] - p[1][1] * p[2][0]) * invDet,
                        (p[0][1] * p[2][0] - p[0][0] * p[2][1]) * invDet,
                        (p[0][0] * p[1][1] - p[0][1] * p[1][0]) * invDet
                    ]
                ];

                const r = rAbsolute[i];

                const relative = [
                    [
                        invParent[0][0] * r[0][0] +
                        invParent[0][1] * r[1][0] +
                        invParent[0][2] * r[2][0],

                        invParent[0][0] * r[0][1] +
                        invParent[0][1] * r[1][1] +
                        invParent[0][2] * r[2][1],

                        invParent[0][0] * r[0][2] +
                        invParent[0][1] * r[1][2] +
                        invParent[0][2] * r[2][2]
                    ],
                    [
                        invParent[1][0] * r[0][0] +
                        invParent[1][1] * r[1][0] +
                        invParent[1][2] * r[2][0],

                        invParent[1][0] * r[0][1] +
                        invParent[1][1] * r[1][1] +
                        invParent[1][2] * r[2][1],

                        invParent[1][0] * r[0][2] +
                        invParent[1][1] * r[1][2] +
                        invParent[1][2] * r[2][2]
                    ],
                    [
                        invParent[2][0] * r[0][0] +
                        invParent[2][1] * r[1][0] +
                        invParent[2][2] * r[2][0],

                        invParent[2][0] * r[0][1] +
                        invParent[2][1] * r[1][1] +
                        invParent[2][2] * r[2][1],

                        invParent[2][0] * r[0][2] +
                        invParent[2][1] * r[1][2] +
                        invParent[2][2] * r[2][2]
                    ]
                ];

                // frame = corrected[parent] @ relative

                const c = corrected[parent];

                frame = [
                    [
                        c[0][0] * relative[0][0] +
                        c[0][1] * relative[1][0] +
                        c[0][2] * relative[2][0],

                        c[0][0] * relative[0][1] +
                        c[0][1] * relative[1][1] +
                        c[0][2] * relative[2][1],

                        c[0][0] * relative[0][2] +
                        c[0][1] * relative[1][2] +
                        c[0][2] * relative[2][2]
                    ],
                    [
                        c[1][0] * relative[0][0] +
                        c[1][1] * relative[1][0] +
                        c[1][2] * relative[2][0],

                        c[1][0] * relative[0][1] +
                        c[1][1] * relative[1][1] +
                        c[1][2] * relative[2][1],

                        c[1][0] * relative[0][2] +
                        c[1][1] * relative[1][2] +
                        c[1][2] * relative[2][2]
                    ],
                    [
                        c[2][0] * relative[0][0] +
                        c[2][1] * relative[1][0] +
                        c[2][2] * relative[2][0],

                        c[2][0] * relative[0][1] +
                        c[2][1] * relative[1][1] +
                        c[2][2] * relative[2][1],

                        c[2][0] * relative[0][2] +
                        c[2][1] * relative[1][2] +
                        c[2][2] * relative[2][2]
                    ]
                ];
            } else {
                frame = rAbsolute[i];
            }
            
        }
        corrected[i] = frame
        
    }
    return corrected

}
function quatFromRotationMatrix(R){
    const m = R;

    const trace = m[0][0] + m[1][1] + m[2][2];

    let x, y, z, w;

    if (trace > 0) {

        const s = 0.5 / Math.sqrt(trace + 1.0);

        w = 0.25 / s;
        x = (m[2][1] - m[1][2]) * s;
        y = (m[0][2] - m[2][0]) * s;
        z = (m[1][0] - m[0][1]) * s;

    } else if (
        m[0][0] > m[1][1] &&
        m[0][0] > m[2][2]
    ) {

        const s = 2.0 * Math.sqrt(
            1.0 +
            m[0][0] -
            m[1][1] -
            m[2][2]
        );

        w = (m[2][1] - m[1][2]) / s;
        x = 0.25 * s;
        y = (m[0][1] + m[1][0]) / s;
        z = (m[0][2] + m[2][0]) / s;

    } else if (m[1][1] > m[2][2]) {

        const s = 2.0 * Math.sqrt(
            1.0 +
            m[1][1] -
            m[0][0] -
            m[2][2]
        );

        w = (m[0][2] - m[2][0]) / s;
        x = (m[0][1] + m[1][0]) / s;
        y = 0.25 * s;
        z = (m[1][2] + m[2][1]) / s;

    } else {

        const s = 2.0 * Math.sqrt(
            1.0 +
            m[2][2] -
            m[0][0] -
            m[1][1]
        );

        w = (m[1][0] - m[0][1]) / s;
        x = (m[0][2] + m[2][0]) / s;
        y = (m[1][2] + m[2][1]) / s;
        z = 0.25 * s;
    }

    // q = np.array([x, y, z, w])
    const q = [x, y, z, w];

    // n = np.linalg.norm(q)
    const n = Math.sqrt(
        q[0] * q[0] +
        q[1] * q[1] +
        q[2] * q[2] +
        q[3] * q[3]
    );

    // return q / n
    if (n > 1e-12) {
        return [
            q[0] / n,
            q[1] / n,
            q[2] / n,
            q[3] / n
        ];
    }

    return [0.0, 0.0, 0.0, 1.0];
}
function computeBoneBindTransforms(model){
    const resPosition = computeBoneRestPositions(model)
    let worldPosition = resPosition.resolved
    const fallbackBones = resPosition.fallbackBones
    worldPosition = worldPosition.map(p => [...p]);
    console.log('worldPosition: ', worldPosition)
    const rAbsolute = []

    for (let i = 0; i < model.boneCount; i++) {
        const m = model.bonesArr[i].matrix;

        if (m.length !== 0x40) {
            throw new Error(`Expected 0x40 bytes, got 0x${m.length.toString(16)}`);
        }

        // 16 float32 little-endian
        const M = [
            [
                m.readFloatLE(0),
                m.readFloatLE(4),
                m.readFloatLE(8),
                m.readFloatLE(12)
            ],
            [
                m.readFloatLE(16),
                m.readFloatLE(20),
                m.readFloatLE(24),
                m.readFloatLE(28)
            ],
            [
                m.readFloatLE(32),
                m.readFloatLE(36),
                m.readFloatLE(40),
                m.readFloatLE(44)
            ],
            [
                m.readFloatLE(48),
                m.readFloatLE(52),
                m.readFloatLE(56),
                m.readFloatLE(60)
            ]
        ];

        console.log("matrix:", M);

        // Python:
        // M[0:3, 0:3].T
        const R = [
            [M[0][0], M[1][0], M[2][0]],
            [M[0][1], M[1][1], M[2][1]],
            [M[0][2], M[1][2], M[2][2]]
        ];

        rAbsolute.push(R);
    }
    const rAbsolute_2 = _autoCorrectBindRotations(model, rAbsolute, worldPosition, fallbackBones)
    //aqui xendo
    const localTranslations = new Array(model.boneCount).fill(null);
    const localQuats = new Array(model.boneCount).fill(null);
    for(let i = 0; i < model.boneCount; i++){
        const parent = model.bonesArr[i].parentId
        let rLocal;
        if(parent === -1){
            localTranslations[i] = worldPosition[i]
            rLocal = rAbsolute_2[i]
        }else{
            // ============================================================
            // r_parent_inv = np.linalg.inv(r_absolute[parent])
            // ============================================================

            const p = rAbsolute_2[parent];
            
            const det =
                p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) -
                p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) +
                p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0]);

            if (Math.abs(det) < 1e-12) {
                throw new Error(`Cannot invert rAbsolute[${parent}]`);
            }

            const invDet = 1.0 / det;

            const rParentInv = [
                [
                    (p[1][1] * p[2][2] - p[1][2] * p[2][1]) * invDet,
                    (p[0][2] * p[2][1] - p[0][1] * p[2][2]) * invDet,
                    (p[0][1] * p[1][2] - p[0][2] * p[1][1]) * invDet
                ],
                [
                    (p[1][2] * p[2][0] - p[1][0] * p[2][2]) * invDet,
                    (p[0][0] * p[2][2] - p[0][2] * p[2][0]) * invDet,
                    (p[0][2] * p[1][0] - p[0][0] * p[1][2]) * invDet
                ],
                [
                    (p[1][0] * p[2][1] - p[1][1] * p[2][0]) * invDet,
                    (p[0][1] * p[2][0] - p[0][0] * p[2][1]) * invDet,
                    (p[0][0] * p[1][1] - p[0][1] * p[1][0]) * invDet
                ]
            ];
            
            // ============================================================
            // delta = world_positions[i] - world_positions[parent]
            // ============================================================

            const delta = [
                worldPosition[i][0] - worldPosition[parent][0],
                worldPosition[i][1] - worldPosition[parent][1],
                worldPosition[i][2] - worldPosition[parent][2]
            ];
            
            // ============================================================
            // local_translations[i] = r_parent_inv @ delta
            // ============================================================

            localTranslations[i] = [
                rParentInv[0][0] * delta[0] +
                rParentInv[0][1] * delta[1] +
                rParentInv[0][2] * delta[2],

                rParentInv[1][0] * delta[0] +
                rParentInv[1][1] * delta[1] +
                rParentInv[1][2] * delta[2],

                rParentInv[2][0] * delta[0] +
                rParentInv[2][1] * delta[1] +
                rParentInv[2][2] * delta[2]
            ];
            
            // ============================================================
            // r_local = r_parent_inv @ r_absolute[i]
            // ============================================================

            const r = rAbsolute_2[i];
            
            rLocal = [
                [
                    rParentInv[0][0] * r[0][0] +
                    rParentInv[0][1] * r[1][0] +
                    rParentInv[0][2] * r[2][0],

                    rParentInv[0][0] * r[0][1] +
                    rParentInv[0][1] * r[1][1] +
                    rParentInv[0][2] * r[2][1],

                    rParentInv[0][0] * r[0][2] +
                    rParentInv[0][1] * r[1][2] +
                    rParentInv[0][2] * r[2][2]
                ],
                [
                    rParentInv[1][0] * r[0][0] +
                    rParentInv[1][1] * r[1][0] +
                    rParentInv[1][2] * r[2][0],

                    rParentInv[1][0] * r[0][1] +
                    rParentInv[1][1] * r[1][1] +
                    rParentInv[1][2] * r[2][1],

                    rParentInv[1][0] * r[0][2] +
                    rParentInv[1][1] * r[1][2] +
                    rParentInv[1][2] * r[2][2]
                ],
                [
                    rParentInv[2][0] * r[0][0] +
                    rParentInv[2][1] * r[1][0] +
                    rParentInv[2][2] * r[2][0],

                    rParentInv[2][0] * r[0][1] +
                    rParentInv[2][1] * r[1][1] +
                    rParentInv[2][2] * r[2][1],

                    rParentInv[2][0] * r[0][2] +
                    rParentInv[2][1] * r[1][2] +
                    rParentInv[2][2] * r[2][2]
                ]
            ];

        }
        localQuats[i] = quatFromRotationMatrix(rLocal)

    }
    return {localTranslations, localQuats, rAbsolute_2, fallbackBones}
}
function matricesAlmostEqual(a, b, tolerance = 1e-8) {
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            if (Math.abs(a[i][j] - b[i][j]) > tolerance) {
                return false;
            }
        }
    }

    return true;
}
function trsToMatrix(t, q, s) {
    // t = [x, y, z]
    // q = [x, y, z, w]
    // s = [sx, sy, sz]

    const [x, y, z, w] = q;

    const R = [
        [
            1 - 2 * (y * y + z * z),
            2 * (x * y - z * w),
            2 * (x * z + y * w)
        ],
        [
            2 * (x * y + z * w),
            1 - 2 * (x * x + z * z),
            2 * (y * z - x * w)
        ],
        [
            2 * (x * z - y * w),
            2 * (y * z + x * w),
            1 - 2 * (x * x + y * y)
        ]
    ];

    const M = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ];

    // M[0:3, 0:3] = R * s[None, :]
    // Escala cada columna de R:
    M[0][0] = R[0][0] * s[0];
    M[0][1] = R[0][1] * s[1];
    M[0][2] = R[0][2] * s[2];

    M[1][0] = R[1][0] * s[0];
    M[1][1] = R[1][1] * s[1];
    M[1][2] = R[1][2] * s[2];

    M[2][0] = R[2][0] * s[0];
    M[2][1] = R[2][1] * s[1];
    M[2][2] = R[2][2] * s[2];

    // M[0:3, 3] = t
    M[0][3] = t[0];
    M[1][3] = t[1];
    M[2][3] = t[2];

    return M;
}
function multiplyMat4(a, b) {
    const result = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
    ];

    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i][j] =
                a[i][0] * b[0][j] +
                a[i][1] * b[1][j] +
                a[i][2] * b[2][j] +
                a[i][3] * b[3][j];
        }
    }

    return result;
}
function decomposeColMatrix(M) {
    // t = M[0:3, 3].copy()
    const t = [
        M[0][3],
        M[1][3],
        M[2][3]
    ];

    // basis_cols = M[0:3, 0:3]
    const basisCols = [
        [M[0][0], M[0][1], M[0][2]],
        [M[1][0], M[1][1], M[1][2]],
        [M[2][0], M[2][1], M[2][2]]
    ];

    // scale = np.linalg.norm(basis_cols, axis=0)
    const scale = [
        Math.sqrt(
            basisCols[0][0] ** 2 +
            basisCols[1][0] ** 2 +
            basisCols[2][0] ** 2
        ),
        Math.sqrt(
            basisCols[0][1] ** 2 +
            basisCols[1][1] ** 2 +
            basisCols[2][1] ** 2
        ),
        Math.sqrt(
            basisCols[0][2] ** 2 +
            basisCols[1][2] ** 2 +
            basisCols[2][2] ** 2
        )
    ];

    // scale_safe = np.where(scale < 1e-12, 1.0, scale)
    const scaleSafe = [
        scale[0] < 1e-12 ? 1.0 : scale[0],
        scale[1] < 1e-12 ? 1.0 : scale[1],
        scale[2] < 1e-12 ? 1.0 : scale[2]
    ];

    // R = basis_cols / scale_safe[None, :]
    const R = [
        [
            basisCols[0][0] / scaleSafe[0],
            basisCols[0][1] / scaleSafe[1],
            basisCols[0][2] / scaleSafe[2]
        ],
        [
            basisCols[1][0] / scaleSafe[0],
            basisCols[1][1] / scaleSafe[1],
            basisCols[1][2] / scaleSafe[2]
        ],
        [
            basisCols[2][0] / scaleSafe[0],
            basisCols[2][1] / scaleSafe[1],
            basisCols[2][2] / scaleSafe[2]
        ]
    ];

    const q = quatFromRotationMatrix(R);

    return [t, q, scale];
}
function addAccessorMat4(arr4x4List) {
    // Equivalente a:
    // np.asarray(..., dtype=np.float32).reshape(-1, 16)

    const arr = new Float32Array(
        arr4x4List.flatMap(m => Array.from(m))
    );

    // Equivalente a arr.tobytes()
    const bv = this._addView(
        Buffer.from(arr.buffer)
    );

    const acc = {
        bufferView: bv,
        componentType: 5126, // G.FLOAT
        count: arr.length / 16,
        type: "MAT4"
    };

    this.g.accessors.push(acc);

    return this.g.accessors.length - 1;
}



function exportXYZBufferToGlft(exportObjArray, exports) {
    const axisFix = AXIS_MATRICES[`none`]
    const obj1Arr = exports.obj1 || []
    const nodes = [];
    const scenes = [{nodes: []}]//{ nodes: [sceneRootIndex] }],
    const accessors = [];
    const bufferViews = [];
    let combinedArrBuffer = [];
    const skins = [];
    const meshes = [];
    const materials = []
    const materialsIdx = []
    function addAccessorF2(arr, target = null) {
        const data = new Float32Array(
            arr.flatMap(v => Array.from(v))
        );

        const bv = _addView(
            Buffer.from(data.buffer),
            target
        );

        const acc = {
            bufferView: bv,
            componentType: 5126, // G.FLOAT
            count: data.length / 2,
            type: "VEC2"
        };

        accessors.push(acc);

        return accessors.length - 1;
    }
    function addAccessorF3(arr, target = null, minmax = false) {
        // np.asarray(arr, dtype=np.float32).reshape(-1, 3)
        const data = new Float32Array(
            arr.flatMap(v => Array.from(v))
        );

        const bv = _addView(
            Buffer.from(data.buffer),
            target
        );

        const acc = {
            bufferView: bv,
            componentType: 5126, // G.FLOAT
            count: data.length / 3,
            type: "VEC3"
        };

        if (minmax && data.length > 0) {
            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];

            for (let i = 0; i < data.length; i += 3) {
                for (let j = 0; j < 3; j++) {
                    if (data[i + j] < min[j]) {
                        min[j] = data[i + j];
                    }

                    if (data[i + j] > max[j]) {
                        max[j] = data[i + j];
                    }
                }
            }

            acc.min = min;
            acc.max = max;
        }

        accessors.push(acc);

        return accessors.length - 1;
    }
    function _singleJointSkinGroup(mesh, model) {
        let boneIdx = 0;

        if (
            mesh.nodeIdx >= 0 &&
            mesh.nodeIdx < model.bonesArr.length
        ) {
            const parent = model.bonesArr[mesh.nodeIdx].parentId;

            if (
                parent >= 0 &&
                parent < model.boneCount
            ) {
                boneIdx = parent;
            }
        }

        return [
            {
                boneIdx,
                vertWeightArr: Array.from(
                    { length: mesh.positions.length },
                    (_, pi) => [pi, 1.0]
                )
            }
        ];
    }
    function addAccessorJoints4(arr) {
        const data = new Uint16Array(
            arr.flatMap(v => Array.from(v))
        );

        const bv = _addView(
            Buffer.from(data.buffer)
        );

        const acc = {
            bufferView: bv,
            componentType: 5123, // G.UNSIGNED_SHORT
            count: data.length / 4,
            type: "VEC4"
        };

        accessors.push(acc);

        return accessors.length - 1;
    }
    function addAccessorIndices(arr) {
        const data = new Uint32Array(arr);

        const bv = _addView(
            Buffer.from(data.buffer),
            34963 // G.ELEMENT_ARRAY_BUFFER
        );

        const acc = {
            bufferView: bv,
            componentType: 5125, // G.UNSIGNED_INT
            count: data.length,
            type: "SCALAR"
        };

        accessors.push(acc);

        return accessors.length - 1;
    }
    function addAccessorF4(arr) {
        const data = new Float32Array(
            arr.flatMap(v => Array.from(v))
        );

        const bv = _addView(
            Buffer.from(data.buffer)
        );

        const acc = {
            bufferView: bv,
            componentType: 5126, // G.FLOAT
            count: data.length / 4,
            type: "VEC4"
        };

        accessors.push(acc);

        return accessors.length - 1;
    }
    function buildMeshNode(mesh, model, nodeIndices, materialIndices, skinIndex, boneCount, heridasMatIdx, scale = 1){
        const vertCache = new Map();

        const positions = [];
        const uvs = [];
        const normals = [];
        const origPosIdx = [];
        function getVertex(pi, ui, ni) {
            const key = `${pi},${ui},${ni}`;

            const v = vertCache.get(key);

            if (v !== undefined) {
                return v;
            }

            const newV = positions.length;

            vertCache.set(key, newV);

            const pos =
                pi < mesh.positions.length
                    ? mesh.positions[pi]
                    : [0, 0, 0];

            positions.push([
                pos[0] * scale,
                pos[1] * scale,
                pos[2] * scale
            ]);

            uvs.push(
                ui < mesh.uvs.length
                    ? mesh.uvs[ui]
                    : [0, 0]
            );

            normals.push(
                ni < mesh.normals.length
                    ? mesh.normals[ni]
                    : [0, 0, 1]
            );

            origPosIdx.push(pi);

            return newV;
        }
        const isHerida = mesh.name.toLowerCase().includes("herida");

        const byMat = new Map();
        console.log("mesh: ", mesh.idxPos)
        for (let f = 0; f < mesh.idxPos.length; f++) {
            const matId =
                f < mesh.materialsId.length
                    ? mesh.materialsId[f]
                    : 0;

            const [pa, pb, pc] = mesh.idxPos[f];
            const [ua, ub, uc] = mesh.idxUv[f];
            const [na, nb, nc] = mesh.idxNormal[f];

            const va = getVertex(pa, ua, na);
            const vb = getVertex(pb, ub, nb);
            const vc = getVertex(pc, uc, nc);

            // winding flipped (source engine's front-face winding is opposite
            // glTF's CCW-front convention -- confirmed backwards in Blender)
            if (!byMat.has(matId)) {
                byMat.set(matId, []);
            }

            byMat.get(matId).push([va, vc, vb]);
        }

        if (positions.length === 0) {
            return;
        }
        const uvsFlipped = uvs.map(([u, v]) => [
            u,
            1.0 - v
        ]);
        const posAcc = addAccessorF3(
            positions,
            34962, // G.ARRAY_BUFFER
            true
        );

        const nrmAcc = addAccessorF3(
            normals,
            34962, // G.ARRAY_BUFFER
        );

        const uvAcc = addAccessorF2(
            uvsFlipped,
            34962, // G.ARRAY_BUFFER
        );
        const attributes = {
            POSITION: posAcc,
            NORMAL: nrmAcc,
            TEXCOORD_0: uvAcc
        }
        skinGroups = mesh.skinGroups && mesh.skinGroups.length > 0 ? mesh.skinGroups : _singleJointSkinGroup(mesh, model)
        const perPosWeights = [];
        
        for (let i = 0; i < skinGroups.length; i++) {
            const {boneIdx, vertWeightArr} = skinGroups[i]
            console.log("boneIdx: ", boneIdx, "vertWeightArr[]: ", skinGroups[i])

            for (let x = 0; x < vertWeightArr.length; x++) {
                const [pi, w] = vertWeightArr[x]
                if (!perPosWeights[pi]) {
                    perPosWeights[pi] = [];
                }

                perPosWeights[pi].push([boneIdx, w]);
            }
        }

        const joints4 = [];
        const weights4 = [];

        for (const pi of origPosIdx) {
            let entries = perPosWeights[pi] ?? [];

            entries = entries
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4);

            if (entries.length === 0) {
                entries = [[0, 1.0]];
            }

            const js = [
                ...entries.map(e => e[0]),
                ...new Array(4 - entries.length).fill(0)
            ];

            const ws = [
                ...entries.map(e => e[1]),
                ...new Array(4 - entries.length).fill(0.0)
            ];

            const tot = ws.reduce((sum, w) => sum + w, 0) || 1.0;

            const normalizedWs = ws.map(w => w / tot);

            joints4.push(js.slice(0, 4));
            weights4.push(normalizedWs.slice(0, 4));
        }
        attributes.JOINTS_0 = addAccessorJoints4(joints4)
        attributes.WEIGHTS_0 = addAccessorF4(weights4)
        const primitives = [];

        for (const [matId, tris] of byMat) {
            const idxFlat = tris.flatMap(tri => tri);

            const idxAcc = addAccessorIndices(idxFlat);

            let mi;

            if (isHerida) {
                mi = heridasMatIdx;
            } else {
                mi = matId < materialIndices.length
                    ? materialIndices[matId]
                    : materialIndices[0];
            }
            primitives.push({attributes: attributes, indices: idxAcc, material: mi, mode: 4})

        }
        const gmesh = {name: mesh.name, primitives: primitives}
        const meshIdx = meshes.length
        meshes.push(gmesh)
        const meshNode = {
            mesh: meshIdx,
            //skin: skins.length,
            name: mesh.name
        };
        const mnodeIdx = nodes.length
        console.log("gmesh: ", gmesh.primitives[0])
        console.log("meshNode: ", meshNode)
        console.log("mnodeIdx: ", mnodeIdx)
        nodes.push(meshNode)
        scenes[0].nodes.push(mnodeIdx)
    }
    function _addView(data, target = null) {
        const off = Buffer.from(data.buffer);
        combinedArrBuffer.push(Buffer.from(data.buffer))
        let byteOffset = 0;
        for(let i = 0; i < combinedArrBuffer.length - 1; i++){
            byteOffset+=combinedArrBuffer[i].length
        }

        const bv = {
            buffer: 0,
            byteOffset: byteOffset,
            byteLength: off.length
        };

        if (target !== null) {
            bv.target = target;
        }
        console.log("bv.target", bv.target)
        bufferViews.push(bv);

        return bufferViews.length - 1;
    }
    function addAccessorMat4(arr4x4List) {
        // Equivalente a:
        // np.asarray(..., dtype=np.float32).reshape(-1, 16)

        const arr = new Float32Array(
            arr4x4List.flatMap(m => Array.from(m))
        );

        // Equivalente a arr.tobytes()
        const bv = _addView(
            arr
        );

        const acc = {
            bufferView: bv,
            componentType: 5126, // G.FLOAT
            count: arr.length / 16,
            type: "MAT4"
        };

        accessors.push(acc);

        return accessors.length - 1;
    }
    function getOrCreateMaterial(model, name, rgba, textureUri) {
        // Buscar si ya existe
        for (let i = 0; i < model.materials.length; i++) {
            const entry = model.materials[i];

            if (
                entry.name === name &&
                entry.textureUri === textureUri
            ) {
                return entry.index;
            }
        }

        const baseColorFactor = [
            rgba[0] / 255.0,
            rgba[1] / 255.0,
            rgba[2] / 255.0,
            rgba.length > 3 ? rgba[3] / 255.0 : 1.0
        ];

        const pbr = {
            baseColorFactor,
            metallicFactor: 0.0,
            roughnessFactor: 0.8
        };

        if (textureUri) {
            const imgIdx = this.g.images.length;

            this.g.images.push({
                uri: textureUri
            });

            const texIdx = this.g.textures.length;

            this.g.textures.push({
                source: imgIdx
            });

            pbr.baseColorTexture = {
                index: texIdx
            };
        }

        const mat = {
            name,
            pbrMetallicRoughness: pbr,
            alphaMode: "MASK",
            alphaCutoff: 0.5,
            doubleSided: true
        };

        const idx = materials.length;

        materials.push(mat);

        // Guardamos en array
        materialsIdx.push({
            name,
            textureUri,
            index: idx
        });

        return idx;
    }
    for(let key in obj1Arr){
                                                                                                                                                                                     
        const model = obj1Arr[key]
        console.log("model", model.boneCount)
        const {localTranslations, localQuats, rAbsolute_2, fallbackBones} = computeBoneBindTransforms(model)
        const localTranslations2 = localTranslations.map(t => [
            t[0] * 0.001, //scale
            t[1] * 0.001, //scale
            t[2] * 0.001  //scale
        ]);
        console.log("localTranslations2: ", localTranslations2)
        if(fallbackBones.length > 0){
            const names = model.bonesArr.filter((row, i) => fallbackBones.indexOf(i)>-1).map(row=>row.nameBone)
            console.warn(`  note: ${fallbackBones.length} bone(s) had no skin-weight data to derive a rest position from, placed at their parent instead: ${names}`)
        }

        const nodeIndices = new Array(model.boneCount).fill([]); 
        const localTrs = new Array(model.boneCount).fill([]);
        for(let i = 0; i < model.boneCount; i++){
            const node = model.bonesArr[i];
            const t = localTranslations2[i];
            const q = localQuats[i];
            const s = [1.0, 1.0, 1.0];
            localTrs[i] = [t, q, s]
            const gn = {
                
                
                rotation: q,
                translation: t,
                scale: s,
                children: [],
                
                
                name: node.nameBone
            }
            const idx = nodes.length
            nodes.push(gn)
            nodeIndices[i] = idx

        }

        const roots = []
        for(let i = 0; i < model.boneCount; i++){
            const node = model.bonesArr[i]
            const gi = nodeIndices[i]
            if(node.parentId === -1){
                roots.push(i)
                const identity4 = [
                    [1, 0, 0, 0],
                    [0, 1, 0, 0],
                    [0, 0, 1, 0],
                    [0, 0, 0, 1]
                ];

                if (!matricesAlmostEqual(axisFix, identity4)) {
                    const [t, q, s]= localTrs[i]
                    const M = multiplyMat4(
                        axisFix,
                        trsToMatrix(t, q, s)
                    );
                    const [nt, nq, ns] = decomposeColMatrix(M);
                    nodes[gi].translation = nt
                    nodes[gi].rotation = nq
                    nodes[gi].scale = ns

                }
            }else{
                const parentGi = nodeIndices[node.parentId]
                console.log("parentGi ", node.parentId)

                nodes[parentGi].children.push(gi)

            }
        }
        const rootNodeIndices = roots.map(i => nodeIndices[i]);
        scenes[0].nodes = rootNodeIndices /*{ nodes: [sceneRootIndex] }*/

        let world = new Array(model.boneCount).fill(null); 
        function getWorld(i) {
            if (world[i] !== null) {
                return world[i];
            }

            const [t, q, s] = localTrs[i];

            let M = trsToMatrix(t, q, s);
            const identity4 = [
                [1, 0, 0, 0],
                [0, 1, 0, 0],
                [0, 0, 1, 0],
                [0, 0, 0, 1]
            ];
            if (model.bonesArr[i].parentId === -1) {
                if (!matricesAlmostEqual(axisFix, identity4)) {
                    M = multiplyMat4(axisFix, M);
                }

                world[i] = M;
            } else {
                world[i] = multiplyMat4(
                    getWorld(model.bonesArr[i].parentId),
                    M
                );
            }

            return world[i];
        }
        for(let i = 0; i < model.boneCount; i++ ){
            getWorld(i)
        }
        let skinIndex = null
        if(model.boneCount > 0){
            const joints = nodeIndices.slice(0, model.boneCount);
            const ibms = Array.from(
                { length: model.boneCount },
                (_, i) => {
                    const M = getWorld(i);

                    // Transpuesta
                    const T = [
                        [M[0][0], M[1][0], M[2][0], M[3][0]],
                        [M[0][1], M[1][1], M[2][1], M[3][1]],
                        [M[0][2], M[1][2], M[2][2], M[3][2]],
                        [M[0][3], M[1][3], M[2][3], M[3][3]]
                    ];

                    // np.float32 + flatten()
                    const flat = [
                        T[0][0], T[0][1], T[0][2], T[0][3],
                        T[1][0], T[1][1], T[1][2], T[1][3],
                        T[2][0], T[2][1], T[2][2], T[2][3],
                        T[3][0], T[3][1], T[3][2], T[3][3]
                    ];

                    return Array.from(new Float32Array(flat));
                }
            );
            const acc = addAccessorMat4(ibms)
            const skin = {
                inverseBindMatrices: acc,
                skeleton: rootNodeIndices.length > 0 ? rootNodeIndices[0] : null,
                joints: joints
            }
            skins.push(skin)
            skinIndex = skins.length - 1

        }
        console.log("skins: ", skins)
        const materialIndices = [];
        console.log("materialsId22: ", model)
        for (const mat of model.materials) {
            const uri = null

            materialIndices.push(
                getOrCreateMaterial(
                    model,
                    mat.name,
                    mat.diffuseRgba,
                    uri
                )
            );
        }

        if (materialIndices.length === 0) {
            materialIndices.push(
                getOrCreateMaterial(
                    model,
                    "default",
                    [200, 200, 200, 255],
                    null
                )
            );
        }

        const heridasUri = null
            ? null
            : null;

        const heridasMatIdx = getOrCreateMaterial(
            model,
            "heridas",
            [255, 255, 255, 255],
            heridasUri
        );

        console.log("model.meshes.length", model.meshes.length)
        for(let mesh of model.meshes){
            buildMeshNode(mesh, model, nodeIndices, materialIndices, skinIndex, model.boneCount, null, 0.001)
        }
    }

  


    let currentByteOffset = 0;

    function padBufferTo4Bytes(buffer) {
        const padding = (4 - (buffer.length % 4)) % 4;
        return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
    }
    
   /* const sceneRootIndex = nodes.length;
    nodes.push({ name: "Scene_Root", children: [] });

    exportObjArray.forEach((exportObj, objIndex) => {
        const verticesList = exportObj.vertex || [];
        const facesList = exportObj.faces || [];
        const bonesList = exportObj.bones || [];
        const uvList = exportObj.uv || [];
        const normalsList = exportObj.normals || [];
        const materialsIdList = exportObj.materialsId || [];
        const idxPos = exportObj.idxPos || [];
        const idxUv = exportObj.idxUv || [];
        const idxNormals = exportObj.idxNormals || [];
        console.log("faceListLenght: ", facesList.length, facesList)
        const vertCache = new Map();

        const positions = [];
        const uvs = [];
        const normals = [];
        const origPosIdx = [];

        function getVertex(pi, ui, ni) {
            const key = `${pi},${ui},${ni}`;

            if (vertCache.has(key)) {
                return vertCache.get(key);
            }

            const v = positions.length;
            vertCache.set(key, v);

            const pos = pi < mesh.positions.length
                ? mesh.positions[pi]
                : [0, 0, 0];

            positions.push([
                pos[0] * scale,
                pos[1] * scale,
                pos[2] * scale
            ]);

            const uv = ui < mesh.uvs.length
                ? mesh.uvs[ui]
                : [0, 0];

            uvs.push([...uv]);

            const normal = ni < mesh.normals.length
                ? mesh.normals[ni]
                : [0, 0, 1];

            normals.push([...normal]);

            origPosIdx.push(pi);

            return v;
        }

        for(let i = 0; i < facesList.length; i++){
            const matId = materialsIdList[i]
            
            const faceArr = facesList[i]
            const uvIdxArr = idxUv[i]
            const normalsIdxArr = idxNormals[i]

            const faceA = getVertex(faceArr[0], faceArr[1], faceArr[2])
            const uvB = getVertex(uvIdxArr[0], uvIdxArr[1], uvIdxArr[2])
            const normalsC = getVertex(normalsIdxArr[0], normalsIdxArr[1], normalsIdxArr[2])
            console.log("faceA, uvB, normalsC: ", faceA, uvB, normalsC)
        }
        
    });

    if (combinedBuffers.length === 0) {
        console.log(`❌ No se encontraron datos válidos para exportar.`);
        return;
    }*/
   const totalBinaryBuffer = Buffer.concat(combinedArrBuffer)
    const gltf = {

        asset: { version: "2.0", generator: "Torrente True Stream Indices Exporter" },
        scenes: scenes,
        nodes: nodes, //revisar
        "scene": 0,
        meshes: meshes,
        materials: materials,
        skins: skins,
        buffers: [{ uri: `data:application/octet-stream;base64,${totalBinaryBuffer.toString('base64')}`, byteLength: totalBinaryBuffer.length }], //revisar
        bufferViews: bufferViews,
        accessors: accessors
    };

    const outputFilePath = process.argv[2] 
        ? process.argv[2].replace(/\.nfo$/i, '.gltf').replace(/\.NFO$/i, '.gltf') 
        : './nfos/Modelo_TrueStreamIndices.gltf';

    fs.writeFileSync(outputFilePath, JSON.stringify(gltf, null, 2));
    console.log(`🎉 ¡Exportación conectando los índices reales de ` + outputFilePath);
}

module.exports = { exportXYZBufferToGlft };
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
    const model = sub_10043F10(meshBuffer, v25);
    
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
    const hullTris = []
    const skinGroups = []
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
                v14.boneIndex = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                v25.dataPos += 4;
                
                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v14 + 1, ElementSize: 4u);
                v14.vertCount = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                v25.dataPos += 4;

                // v16 = malloc(Size: 4 * v14[1]);
                // v14[2] = v16;
                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v16, ElementSize: v18);
                const bytesToRead = 4 * v14.vertCount;
                v14.val2_ptr = v25.streamPtr.readAbsolute(v25.dataPos, bytesToRead);
                let vertex = []
                for(let i = 0; i < v14.val2_ptr.length / 4; i++){
                    vertex.push(v14.val2_ptr.readInt32LE(i * 4))
                }
                
                v25.dataPos += bytesToRead;

                // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v14 + 3, ElementSize: 4u);
                v14.hasWeight = v25.streamPtr.readAbsolute(v25.dataPos, 4).readUInt32LE(0);
                
                v25.dataPos += 4;
                const weight = []
                // if ( v14[3] != 0 )
                if (v14.hasWeight !== 0) {
                    // v17 = malloc(Size: 4 * *v15); // NOTA: *v15 es v14[1] en la estructura original
                    // v14[4] = v17;
                    // vtFFChunk::Read(this: (vtFFChunk *)v25, Buffer: v17, ElementSize: v19);
                    const extraBytes = 4 * v14.vertCount;
                    v14.val4_ptr = v25.streamPtr.readAbsolute(v25.dataPos, extraBytes);
                    
                    for(let i = 0; i < v14.val4_ptr.length / 4; i++){
                        weight.push(v14.val4_ptr.readFloatLE(i * 4))
                    }
                    console.log("v14.weight: ",weight)
                    v25.dataPos += extraBytes;
                } else {
                    v14.val4_ptr = null;
                }
                skinGroups.push({boneIdx: v14.boneIndex, vertWeightArr: vertex.map((vertexIndex, i) => [
                    vertexIndex,
                    weight[i]
                ])})

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
    return { skinGroups: skinGroups, materialsId: model.materialsId}
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
const exportsTemp = {
    obj1: []
}
// while ( vtFFChunk::Next(this: &v50) != 0 )
while (v50.next() !== 0) {
    console.log(`[RAÍZ] Identificado Chunk: ${v50.chunkId} | Tamaño reservado: ${v50.chunkSize} bytes`);
    
    if (v50.chunkId === 'OBJ1') {
        console.log(">>> Entrando a sub_10043040(v50) ...");
        const obj1Response = sub_10043040(v50)
        exportsTemp.obj1.push(obj1Response)
        // Aquí llamarás a tu implementación de sub_10043040 pasando 'v50'
    }else if(v50.chunkId === 'CPY1'){
        // Asegúrate de que exportObj.cpys o una lista equivalente esté inicializada
        if (!exportObj.cpys) exportObj.cpys = [];

        // Equivalente a: vtFFChunk::vtFFChunk(this: &v53, a2: &v50);
        const v53 = new VtFFChunk(v29); // v29 es el chunk actual (padre, ej: CPY1)

        // Validación de la cabecera INFO
        if (v53.chunkId !== 'INFO') {
            throw new Error(`[Excepción 1037] CHUNK INFO NO ENCONTRADO EN CPY1`);
        }

        // 1. Leer los 64 bytes (0x40u) de la matriz de transformación
        const cpyMatrixData = v53.streamPtr.readAbsolute(v53.dataPos, 0x40);
        v53.dataPos += 0x40;

        // 2. Buscar si hay un bloque CSTR anidado con el nombre (igual que *((_DWORD *)v8 + 16))
        let cpyName = null;
        if (v53.findFirst('CSTR') === 1) { // o findNext según aplique en tu implementación de chunks
            const cstrSize = v53.chunkSize - 8;
            const nameBuffer = v53.streamPtr.readAbsolute(v53.dataPos, cstrSize);
            cpyName = nameBuffer.toString('ascii');
        }
        console.log("cpyName: ", cpyName)
        // 3. Almacenar el elemento procesado en tu objeto de exportación (equivalente al array dinámico de 80 bytes)
        exportObj.cpys.push({
            name: cpyName ? cpyName.replace(/\0/g, '').trim() : `CPY_${exportObj.cpys.length}`,
            matrix: cpyMatrixData
        });

        console.log(`[OBJ1] SubProcesando CPY1 #${exportObj.cpys.length - 1} | Nombre: ${cpyName ? cpyName.replace(/\0/g, '') : 'Sin nombre'}`);
    }

}
function diagnosticarEsqueleto(bonesList) {
    console.log("\n====== DIAGNÓSTICO DE LA JERARQUÍA DE HUESOS ======");
    console.log(`Total de huesos leídos: ${bonesList.length}\n`);

    bonesList.forEach((bone, index) => {
        let name = bone.nameBone ? bone.nameBone.replace(/\0/g, '').trim() : `Hueso_${index}`;
        let pId = bone.parentId;

        // Extraer traslación (Posición X, Y, Z local)
        let posX = 0, posY = 0, posZ = 0;
        if (bone.matrix && Buffer.isBuffer(bone.matrix) && bone.matrix.length >= 64) {
            posX = bone.matrix.readFloatLE(48).toFixed(4); // Offset 12 * 4
            posY = bone.matrix.readFloatLE(52).toFixed(4); // Offset 13 * 4
            posZ = bone.matrix.readFloatLE(56).toFixed(4); // Offset 14 * 4
            
        }

        let relacion = "";
        if (pId === undefined || pId === -1 || pId === 0xFFFFFFFF) {
            relacion = "-> [RAÍZ PRINCIPAL] (Cuelga de la escena)";
        } else if (pId >= 0 && pId < bonesList.length) {
            let parentName = bonesList[pId].nameBone ? bonesList[pId].nameBone.replace(/\0/g, '').trim() : `Hueso_${pId}`;
            relacion = `-> [HIJO DE] Hueso #${pId} ("${parentName}")`;
        } else {
            relacion = `-> ⚠️ [PARENT ID CORRUPTO / FUERA DE RANGO: ${pId}]`;
        }

        console.log(`Hueso #${index} ["${name}"] | Posición Local: (${posX}, ${posY}, ${posZ}) ${relacion}`);
    });
    console.log("====================================================\n");
}
exportXYZBufferToGlft(exportsArr, exportsTemp)