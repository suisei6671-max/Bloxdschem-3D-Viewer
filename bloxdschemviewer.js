const VERSION = "alpha-0.15-optimized";

const logEl = document.getElementById("log");

function log(...a) {
    console.log(...a);
    logEl.textContent += a.map(v => {
        if (typeof v === "string") return v;
        try {
            return JSON.stringify(v, null, 2);
        } catch {
            return String(v);
        }
    }).join(" ") + "\n";
    logEl.scrollTop = logEl.scrollHeight;
}

log("[BOOT]", VERSION);

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, {
    antialias: false,
    preserveDrawingBuffer: true
});

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0.15, 0.16, 0.2, 1);

const camera = new BABYLON.ArcRotateCamera(
    "cam",
    -Math.PI / 2,
    1.2,
    40,
    new BABYLON.Vector3(0, 0, 0),
    scene
);
camera.attachControl(canvas, true);

const light = new BABYLON.HemisphericLight(
    "light",
    new BABYLON.Vector3(0, 1, 0),
    scene
);
light.intensity = 2;

const textureData = {};
const textureCache = new Map();
let blockMap = {};

/**
 * Babylon faces: 0:front, 1:back, 2:right, 3:left, 4:top, 5:bottom
 * Bloxd faces: [left(0), right(1), top(2), bottom(3), front(4), back(5)]
 */
const FACE_MAP = [4, 5, 1, 0, 2, 3];

/**
 * Rotation for each Babylon face to match Bloxd's orientation
 */
const FACE_ROTATION = {
    0: 90,  // front
    1: 90,  // back
    2: 90,  // right
    3: 90,  // left
    4: -90, // top
    5: -90  // bottom
};

async function extractTextures() {
    log("[TEXTURE] scanning");
    try {
        const res = await fetch("./76njx.4.74e4a68f.chunk.js");
        const src = await res.text();
        log("[TEXTURE] source size", src.length);

        const pngRegex = /"\.\/([^"]+?)\.png":(\d+)/g;
        const dataRegex = /(\d+):[^\n]*?exports\s*=\s*"([^"]+)"/g;

        const pngMap = new Map();
        const base64Map = new Map();

        let m;
        while ((m = pngRegex.exec(src)) !== null) {
            pngMap.set(m[1], parseInt(m[2]));
        }
        while ((m = dataRegex.exec(src)) !== null) {
            const id = parseInt(m[1]);
            const data = m[2];
            if (data.startsWith("data:image")) {
                base64Map.set(id, data);
            }
        }

        pngMap.forEach((id, name) => {
            const data = base64Map.get(id);
            if (data) textureData[name] = data;
        });

        log("[TEXTURES] loaded", Object.keys(textureData).length);
    } catch (e) {
        log("[TEXTURE ERROR]", e.message);
    }
}

async function loadBlockData() {
    try {
        const res = await fetch("./blockData.json");
        const json = await res.json();
        blockMap = {};
        for (let i = 0; i < json.length; i++) {
            blockMap[i] = json[i];
        }
        log("[BLOCKS] loaded", Object.keys(blockMap).length);
    } catch (e) {
        log("[BLOCK DATA ERROR]", e.message);
    }
}

function getTexture(name, rotation = 0) {
    // Bloxd uses degrees for rotation in some contexts, but Babylon uses radians for wAng.
    // The user mentioned FACE_ROTATION was not applied.
    const key = `${name}_rot_${rotation}`;
    if (textureCache.has(key)) return textureCache.get(key);

    const data = textureData[name];
    if (!data) return null;

    const tex = new BABYLON.Texture(data, scene, false, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);
    
    // Apply rotation to the texture coordinates
    // Bloxd's FACE_ROTATION values are typically 90, -90, etc.
    if (rotation !== 0) {
        tex.wAng = rotation * (Math.PI / 180);
    }
    
    textureCache.set(key, tex);
    return tex;
}

function clearScene() {
    scene.meshes.slice().forEach(m => m.dispose());
    textureCache.clear();
}

function readULEB(bytes, state) {
    let result = 0;
    let shift = 0;
    while (true) {
        const byte = bytes[state.offset++];
        result |= (byte & 127) << shift;
        if ((byte & 128) === 0) break;
        shift += 7;
    }
    return result;
}

function decodeBlocks(bytes) {
    const arr = new Uint16Array(32 * 32 * 32);
    const state = { offset: 0 };
    while (state.offset < bytes.length) {
        const index = readULEB(bytes, state);
        if (state.offset >= bytes.length) break;
        const id = readULEB(bytes, state);
        if (index < arr.length) arr[index] = id;
    }
    return arr;
}

function idxToXYZ(i) {
    return {
        x: i % 32,
        y: Math.floor(i / 32) % 32,
        z: Math.floor(i / 1024)
    };
}

async function parseSchem(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let offset = 4;

    function readVarInt() {
        let shift = 0;
        let result = 0;
        while (true) {
            const b = bytes[offset++];
            result |= (b & 127) << shift;
            if (!(b & 128)) break;
            shift += 7;
        }
        return (result >>> 1) ^ -(result & 1);
    }

    function readString() {
        const len = readVarInt();
        const slice = bytes.slice(offset, offset + len);
        offset += len;
        return new TextDecoder().decode(slice);
    }

    function readBytes() {
        const len = readVarInt();
        const slice = bytes.slice(offset, offset + len);
        offset += len;
        return slice;
    }

    const schem = {
        name: readString(),
        x: readVarInt(), y: readVarInt(), z: readVarInt(),
        sizeX: readVarInt(), sizeY: readVarInt(), sizeZ: readVarInt(),
        chunks: []
    };

    while (offset < bytes.length) {
        const count = readVarInt();
        if (count <= 0) break;
        for (let i = 0; i < count; i++) {
            schem.chunks.push({
                x: readVarInt(), y: readVarInt(), z: readVarInt(),
                blocks: readBytes()
            });
        }
    }
    return schem;
}

/**
 * Optimized building using Thin Instances
 */
async function buildSchem(schem) {
    clearScene();
    log("[BUILD] starting optimized build");

    const blockPositions = new Map(); // Map<blockId, Vector3[]>

    for (const chunk of schem.chunks) {
        const decoded = decodeBlocks(new Uint8Array(chunk.blocks));
        for (let i = 0; i < decoded.length; i++) {
            const rawId = decoded[i];
            if (rawId === 0) continue;
            const blockId = rawId - 1;
            const pos = idxToXYZ(i);
            const worldPos = new BABYLON.Vector3(
                chunk.z * 32 + pos.z,
                chunk.y * 32 + pos.y,
                chunk.x * 32 + pos.x
            );

            if (!blockPositions.has(blockId)) blockPositions.set(blockId, []);
            blockPositions.get(blockId).push(worldPos);
        }
    }

    let totalPlaced = 0;
    for (const [blockId, positions] of blockPositions) {
        const block = blockMap[blockId];
        if (!block) continue;

        const mesh = BABYLON.MeshBuilder.CreateBox("block_" + blockId, { size: 1 }, scene);
        
        // Setup Material
        if (typeof block.textureInfo === "string") {
            const mat = new BABYLON.StandardMaterial("mat_" + blockId, scene);
            mat.diffuseTexture = getTexture(block.textureInfo);
            mat.specularColor = BABYLON.Color3.Black();
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.disableLighting = true;
            mesh.material = mat;
        } else {
            const multi = new BABYLON.MultiMaterial("multi_" + blockId, scene);
            for (let face = 0; face < 6; face++) {
                const bloxdFace = FACE_MAP[face];
                const texIndex = block.texturePerSide?.[bloxdFace] ?? 0;
                const texName = block.textureInfo[texIndex];
                const rot = FACE_ROTATION[face] ?? 0;

                const mat = new BABYLON.StandardMaterial(`mat_${blockId}_f${face}`, scene);
                mat.diffuseTexture = getTexture(texName, rot);
                mat.specularColor = BABYLON.Color3.Black();
                mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
                mat.disableLighting = true;
                multi.subMaterials.push(mat);
            }
            mesh.material = multi;
            
            // Define submeshes for multi-material
            mesh.subMeshes = [];
            const verticesCount = mesh.getTotalVertices();
            for (let i = 0; i < 6; i++) {
                new BABYLON.SubMesh(i, 0, verticesCount, i * 6, 6, mesh);
            }
        }

        // Apply Thin Instances
        const matricesData = new Float32Array(positions.length * 16);
        for (let i = 0; i < positions.length; i++) {
            const matrix = BABYLON.Matrix.Translation(positions[i].x, positions[i].y, positions[i].z);
            matrix.copyToArray(matricesData, i * 16);
        }
        mesh.thinInstanceSetBuffer("matrix", matricesData, 16);
        
        totalPlaced += positions.length;
    }

    log("[DONE] total blocks:", totalPlaced);
}

document.getElementById("buildBtn").onclick = async () => {
    try {
        log("[START]");
        await extractTextures();
        await loadBlockData();

        const file = document.getElementById("schemInput").files[0];
        if (!file) {
            alert("schemファイルを選択してください");
            return;
        }

        const schem = await parseSchem(file);
        log("[SCHEM]", schem.name);
        await buildSchem(schem);
    } catch (e) {
        console.error(e);
        log("[ERROR]", e.message);
    }
};

engine.runRenderLoop(() => {
    scene.render();
});

window.addEventListener("resize", () => engine.resize());

log("[READY]");
