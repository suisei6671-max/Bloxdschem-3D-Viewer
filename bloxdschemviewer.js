const VERSION = "alpha-0.38-perfect-sync-from-source";

const logEl = document.getElementById("log");

function log(...a) {
    const s = a.join(" ");
    console.log(s);
    if (logEl) {
        logEl.innerText += s + "\n";
        logEl.scrollTop = logEl.scrollHeight;
    }
}

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true);

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

const camera = new BABYLON.ArcRotateCamera(
    "cam",
    Math.PI / 4,
    Math.atan(Math.SQRT2),
    100,
    new BABYLON.Vector3(0, 0, 0),
    scene
);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.attachControl(canvas, true, false);
camera.minZ = -1000;
camera.maxZ = 1000;

function updateOrtho(size) {
    const aspect = canvas.width / canvas.height;
    camera.orthoTop = size;
    camera.orthoBottom = -size;
    camera.orthoLeft = -size * aspect;
    camera.orthoRight = size * aspect;
}
updateOrtho(10);

canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1.1 : 0.9;
    const currentTop = camera.orthoTop || 10;
    const newTop = Math.max(0.1, Math.min(500, currentTop * delta));
    updateOrtho(newTop);
}, { passive: false });

const light = new BABYLON.HemisphericLight(
    "light",
    new BABYLON.Vector3(0, 1, 0),
    scene
);
light.intensity = 1.0;

// Assets
let blockMap = {};
let textureCache = {};
let isAssetsLoaded = false;

async function initAssets() {
    if (isAssetsLoaded) return;
    log("[ASSETS] Loading blockData.json and images.js...");
    try {
        const [blockDataRes, imagesJsRes] = await Promise.all([
            fetch("blockData.json"),
            fetch("images.js")
        ]);
        const blockData = await blockDataRes.json();
        blockMap = blockData.reduce((acc, b, i) => {
            acc[i] = b;
            return acc;
        }, {});
        log(`[ASSETS] Loaded ${blockData.length} block entries.`);

        const imagesJsText = await imagesJsRes.text();
        const textures = extractTextures(imagesJsText);
        textureCache = textures;
        log(`[ASSETS] Successfully mapped ${Object.keys(textures).length} textures.`);
        isAssetsLoaded = true;
    } catch (e) {
        log("[ASSETS] Error loading assets:", e);
    }
}

function extractTextures(jsContent) {
    const mapping = {};
    const idToName = {};
    
    // 1. Extract filename to ID mappings: "./stone.png": 3186
    const mapRegex = /"\.\/([^"]+)\.png"\s*:\s*(\d+)/g;
    let match;
    while ((match = mapRegex.exec(jsContent)) !== null) {
        const name = match[1];
        const id = match[2];
        idToName[id] = name;
    }

    // 2. Extract ID to Base64 mappings: 3186: FF => { FF.exports = "data:..." }
    const dataRegex = /(\d+)\s*:\s*(?:[a-zA-Z0-9_]+)\s*=>\s*\{\s*(?:[a-zA-Z0-9_]+)\.exports\s*=\s*"([^"]+)"/g;
    while ((match = dataRegex.exec(jsContent)) !== null) {
        const id = match[1];
        const base64 = match[2];
        if (idToName[id]) {
            const name = idToName[id];
            mapping[name] = base64;
            // Also map sub-paths if any
            if (name.includes("/")) {
                const parts = name.split("/");
                mapping[parts[parts.length - 1]] = base64;
            }
        }
    }

    // Fallback for direct data:image strings if mapping failed
    if (Object.keys(mapping).length === 0) {
        const fallbackRegex = /"data:image\/png;base64,([^"]+)"/g;
        let i = 0;
        while ((match = fallbackRegex.exec(jsContent)) !== null && i < 100) {
            mapping[`fallback_${i++}`] = match[0];
        }
    }

    return mapping;
}

async function getRotatedTexture(name, rotation = 0) {
    const base64 = textureCache[name];
    if (!base64) return null;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 16;
            canvas.height = 16;
            const ctx = canvas.getContext("2d");
            ctx.translate(8, 8);
            ctx.rotate((rotation * Math.PI) / 2);
            ctx.drawImage(img, -8, -8, 16, 16);
            const tex = new BABYLON.Texture(canvas.toDataURL(), scene);
            tex.magFilter = BABYLON.Texture.NEAREST_SAMPLINGMODE;
            resolve(tex);
        };
        img.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
    });
}

// Bloxd Schematic Logic (Perfect Sync with もどす.html)
function readULEB(bytes, state) {
    let shift = 0, value = 0;
    while (true) {
        const byte = bytes[state.offset++];
        value |= (byte & 127) << shift;
        shift += 7;
        if (!(byte & 128)) break;
    }
    return value;
}

function decodeBlocks(bytes) {
    const blocks = [];
    const state = { offset: 0 };
    while (state.offset < bytes.length) {
        const count = readULEB(bytes, state);
        const id = readULEB(bytes, state);
        for (let j = 0; j < count; j++) {
            blocks.push(id);
        }
    }
    return blocks;
}

function idxToXYZ(i) {
    // Matches もどす.html exactly: x is slowest, z is fastest
    return { 
        x: Math.floor(i / 1024), 
        y: Math.floor(i / 32) % 32, 
        z: i % 32 
    };
}

async function parseSchem(file) {
    const buf = await file.arrayBuffer();
    const full = new Uint8Array(buf);
    const sliced = full.slice(4);
    
    // Simple Avro-like parser for the specific structure
    let offset = 0;
    function readStr() {
        const len = sliced[offset++];
        const s = new TextDecoder().decode(sliced.slice(offset, offset + len));
        offset += len;
        return s;
    }
    function readInt() {
        let n = 0, s = 0;
        while (true) {
            const b = sliced[offset++];
            n |= (b & 0x7f) << s;
            if (!(b & 0x80)) break;
            s += 7;
        }
        return (n >>> 1) ^ -(n & 1); // zigzag
    }

    const schem = { name: readStr(), x: readInt(), y: readInt(), z: readInt(), sizeX: readInt(), sizeY: readInt(), sizeZ: readInt(), chunks: [] };
    const chunkCount = readInt();
    for (let i = 0; i < chunkCount; i++) {
        const cx = readInt(), cy = readInt(), cz = readInt();
        const len = readInt();
        const blocks = sliced.slice(offset, offset + len);
        offset += len;
        schem.chunks.push({ x: cx, y: cy, z: cz, blocks });
    }
    return schem;
}

function createFaceMesh(faceIndex, material, scaling, offset) {
    let width = 1, height = 1;
    switch(faceIndex) {
        case 0: case 1: width = scaling.x; height = scaling.y; break; // Front/Back
        case 2: case 3: width = scaling.z; height = scaling.y; break; // Right/Left
        case 4: case 5: width = scaling.x; height = scaling.z; break; // Top/Bottom
    }

    const plane = BABYLON.MeshBuilder.CreatePlane(`face_${faceIndex}`, { width, height }, scene);
    plane.material = material;

    switch(faceIndex) {
        case 0: plane.rotation.y = 0; plane.position.set(offset.x, offset.y, -0.5 * scaling.z + offset.z); break;
        case 1: plane.rotation.y = Math.PI; plane.position.set(offset.x, offset.y, 0.5 * scaling.z + offset.z); break;
        case 2: plane.rotation.y = -Math.PI / 2; plane.position.set(0.5 * scaling.x + offset.x, offset.y, offset.z); break;
        case 3: plane.rotation.y = Math.PI / 2; plane.position.set(-0.5 * scaling.x + offset.x, offset.y, offset.z); break;
        case 4: plane.rotation.x = Math.PI / 2; plane.position.set(offset.x, 0.5 * scaling.y + offset.y, offset.z); break;
        case 5: plane.rotation.x = -Math.PI / 2; plane.position.set(offset.x, -0.5 * scaling.y + offset.y, offset.z); break;
    }
    plane.bakeCurrentTransformIntoVertices();
    return plane;
}

const FACE_MAP = [0, 1, 4, 5, 2, 3]; // Bloxd: Front, Back, Right, Left, Top, Bottom
const FACE_ROTATION = [0, 0, 0, 0, 0, 0];

window.currentSchemBlocks = [];

async function buildSchem(schem) {
    clearScene();
    log("[BUILD] starting...");
    const blockPositions = new Map();
    const blockStats = new Map();
    window.currentSchemBlocks = [];

    for (const chunk of schem.chunks) {
        const decoded = decodeBlocks(new Uint8Array(chunk.blocks));
        let i = 0;
        for (let x = 0; x < 32; x++) {
            for (let y = 0; y < 32; y++) {
                for (let z = 0; z < 32; z++) {
                    const rawId = decoded[i++];
                    if (rawId === 0) continue;
                    const blockId = rawId - 1;
                    
                    // Matches もどす.html exactly
                    const worldX = chunk.x * 32 + x;
                    const worldY = chunk.y * 32 + y;
                    const worldZ = chunk.z * 32 + z;
                    
                    const worldPos = new BABYLON.Vector3(worldX, worldY, worldZ);
                    window.currentSchemBlocks.push({ id: blockId, x: worldX, y: worldY, z: worldZ });
                    
                    if (!blockPositions.has(blockId)) blockPositions.set(blockId, []);
                    blockPositions.get(blockId).push(worldPos);
                }
            }
        }
    }
    
    let totalPlaced = 0;
    for (const [blockId, positions] of blockPositions) {
        const block = blockMap[blockId];
        if (!block) {
            blockStats.set(blockId, { status: "FAILED", reason: "Missing in blockData.json", count: positions.length });
            continue;
        }
        
        const textureInfo = block.textureInfo;
        if (!textureInfo) {
            blockStats.set(blockId, { status: "FAILED", reason: "No textureInfo", count: positions.length, name: block.name });
            continue;
        }

        // Slab Logic (Face-by-Face Mapping)
        const hp = block.halfblockPlacement ?? 0;
        const rot = block.rot ?? 1;
        const isSlab = block.model === "Slab";

        let facesCreated = 0;
        for (let face = 0; face < 6; face++) {
            let scaling = new BABYLON.Vector3(1, 1, 1);
            let offset = new BABYLON.Vector3(0, 0, 0);
            let texIndex = FACE_MAP[face];

            if (isSlab) {
                if (hp === 0) { // Bottom
                    scaling.y = 0.5; offset.y = -0.25;
                } else if (hp === 1) { // Top
                    scaling.y = 0.5; offset.y = 0.25;
                } else if (hp === 2) { // Side
                    if (rot === 1) { // Z-
                        scaling.z = 0.5; offset.z = -0.25;
                        // Map faces to textures as if rotated 90deg around X
                        const map = [2, 3, 4, 5, 1, 0]; // Front=2, Back=3, Top=1, Bottom=0
                        texIndex = map[face];
                    } else if (rot === 2) { // X-
                        scaling.x = 0.5; offset.x = -0.25;
                        const map = [4, 5, 2, 3, 0, 1]; // Right=2, Left=3, Top=0, Bottom=1
                        texIndex = map[face];
                    } else if (rot === 3) { // Z+
                        scaling.z = 0.5; offset.z = 0.25;
                        const map = [3, 2, 4, 5, 0, 1]; // Front=3, Back=2, Top=0, Bottom=1
                        texIndex = map[face];
                    } else if (rot === 4) { // X+
                        scaling.x = 0.5; offset.x = 0.25;
                        const map = [5, 4, 3, 2, 0, 1]; // Right=3, Left=2, Top=0, Bottom=1
                        texIndex = map[face];
                    }
                }
            }

            const texName = Array.isArray(textureInfo) ? textureInfo[texIndex] : textureInfo;
            if (!texName) continue;

            const mat = new BABYLON.StandardMaterial(`mat_${blockId}_f${face}`, scene);
            const tex = await getRotatedTexture(texName, FACE_ROTATION[face] ?? 0);
            if (tex) {
                mat.diffuseTexture = tex;
                mat.diffuseTexture.hasAlpha = true;
            } else {
                mat.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
            }
            mat.disableLighting = true;
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.backFaceCulling = true;
            mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;

            const faceMesh = createFaceMesh(face, mat, scaling, offset);
            const matricesData = new Float32Array(positions.length * 16);
            for (let i = 0; i < positions.length; i++) {
                const matrix = BABYLON.Matrix.Translation(positions[i].x, positions[i].y, positions[i].z);
                matrix.copyToArray(matricesData, i * 16);
            }
            faceMesh.thinInstanceSetBuffer("matrix", matricesData, 16);
            facesCreated++;
        }
        
        if (facesCreated > 0) {
            blockStats.set(blockId, { status: "SUCCESS", count: positions.length, name: block.name, model: block.model });
            totalPlaced += positions.length;
        }
    }

    log(`[BUILD] DONE. Total blocks: ${totalPlaced}`);
    log("\n[BUILD SUMMARY]");
    for (const [id, stat] of blockStats) {
        const icon = stat.status === "SUCCESS" ? "✅" : "❌";
        log(`${icon} ID ${id}: ${stat.name || "Unknown"} (${stat.model || "Cube"}) x${stat.count} - ${stat.status === "FAILED" ? stat.reason : "SUCCESS"}`);
    }

    // Center camera
    if (totalPlaced > 0) {
        const min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
        const max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
        for (const posList of blockPositions.values()) {
            for (const p of posList) {
                min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
                max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
            }
        }
        const center = min.add(max).scale(0.5);
        camera.setTarget(center);
        const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
        updateOrtho(size * 0.8 + 2);
    }
}

function clearScene() {
    scene.meshes.slice().forEach(m => {
        if (m !== camera) m.dispose();
    });
}

engine.runRenderLoop(() => {
    scene.render();
});

window.addEventListener("resize", () => {
    engine.resize();
    updateOrtho(camera.orthoTop);
});

document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await initAssets();
    const schem = await parseSchem(file);
    log(`[SCHEM] ${schem.name}`);
    await buildSchem(schem);
});

log(`BloxdSchemViewer ${VERSION} ready.`);
