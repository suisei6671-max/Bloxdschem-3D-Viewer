const VERSION = "alpha-0.39-official-slab-logic-sync";

const logEl = document.getElementById("log");

function log(...a) {
    const s = a.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" ");
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
light.intensity = 1.5;

// Assets
let blockMap = {};
let textureData = {};
let textureCache = new Map();
let isAssetsLoaded = false;

async function initAssets() {
    if (isAssetsLoaded) return;
    log("[ASSETS] Loading assets...");
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

        const src = await imagesJsRes.text();
        const pngToIdRegex = /"\.\/([^"]+?)\.png"\s*:\s*(\d+)/g;
        const pngMap = new Map();
        let m;
        while ((m = pngToIdRegex.exec(src)) !== null) {
            const fullPath = m[1];
            const filename = fullPath.split('/').pop();
            const id = parseInt(m[2]);
            pngMap.set(filename, id);
            pngMap.set(fullPath, id);
        }

        const idToDataRegex = /(\d+)\s*:\s*[^=]*?=>\s*\{[^}]*?exports\s*=\s*"(data:image\/png;base64,[^"]+)"/g;
        const idToData = new Map();
        while ((m = idToDataRegex.exec(src)) !== null) {
            idToData.set(parseInt(m[1]), m[2]);
        }

        let count = 0;
        pngMap.forEach((id, name) => {
            if (idToData.has(id)) {
                textureData[name] = idToData.get(id);
                count++;
            }
        });
        log(`[ASSETS] Loaded ${Object.keys(blockMap).length} blocks and ${count} textures.`);
        isAssetsLoaded = true;
    } catch (e) {
        log("[ASSETS] Error:", e);
    }
}

async function getRotatedTexture(name, deg) {
    const key = `${name}_rot_${deg}`;
    if (textureCache.has(key)) return textureCache.get(key);
    const src = textureData[name];
    if (!src) return null;
    return new Promise(resolve => {
        const img = new Image();
        img.src = src;
        img.onload = () => {
            const c = document.createElement("canvas");
            c.width = 16; c.height = 16;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            ctx.translate(8, 8);
            if (deg !== 0) ctx.rotate(deg * Math.PI / 180);
            ctx.drawImage(img, -8, -8, 16, 16);
            const tex = new BABYLON.DynamicTexture(key, { width: 16, height: 16 }, scene, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);
            const tctx = tex.getContext();
            tctx.imageSmoothingEnabled = false;
            tctx.clearRect(0, 0, 16, 16);
            tctx.drawImage(c, 0, 0);
            tex.update();
            tex.updateSamplingMode(BABYLON.Texture.NEAREST_SAMPLINGMODE);
            textureCache.set(key, tex);
            resolve(tex);
        };
        img.onerror = () => resolve(null);
    });
}

// Bloxd Schematic Logic (Perfect Sync with もどす.html)
function decodeBlocks(bytes) {
    let i = 0;
    const blocks = [];
    function leb() {
        let shift = 0, value = 0;
        while (true) {
            const byte = bytes[i++];
            value |= (byte & 127) << shift;
            shift += 7;
            if (!(byte & 128)) break;
        }
        return value;
    }
    while (i < bytes.length) {
        const count = leb();
        const id = leb();
        for (let j = 0; j < count; j++) blocks.push(id);
    }
    return blocks;
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

    const finalBlocks = [];
    for (const c of schem.chunks) {
        const arr = decodeBlocks(new Uint8Array(c.blocks));
        let i = 0;
        for (let x = 0; x < 32; x++) {
            for (let y = 0; y < 32; y++) {
                for (let z = 0; z < 32; z++) {
                    const id = arr[i++];
                    if (id === 0) continue;
                    finalBlocks.push({
                        x: c.x * 32 + x,
                        y: c.y * 32 + y,
                        z: c.z * 32 + z,
                        id: id
                    });
                }
            }
        }
    }
    return { name: schem.name, blocks: finalBlocks };
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

const FACE_MAP = [4, 5, 1, 0, 2, 3]; // Bloxd: Front, Back, Right, Left, Top, Bottom
const FACE_ROTATION = { 0: 0, 1: 0, 2: 0, 3: 0, 4: -90, 5: -90 };

async function buildSchem(schem) {
    clearScene();
    log("[BUILD] starting...");
    const blockPositions = new Map();
    const blockStats = new Map();
    window.currentSchemBlocks = [];

    for (const b of schem.blocks) {
        const blockId = b.id - 1;
        const worldPos = new BABYLON.Vector3(b.x, b.y, b.z);
        window.currentSchemBlocks.push({ id: blockId, x: b.x, y: b.y, z: b.z });
        if (!blockPositions.has(blockId)) blockPositions.set(blockId, []);
        blockPositions.get(blockId).push(worldPos);
    }
    
    let totalPlaced = 0;
    for (const [blockId, positions] of blockPositions) {
        const block = blockMap[blockId];
        if (!block || !block.textureInfo) {
            blockStats.set(blockId, { status: "FAILED", reason: "Missing data", count: positions.length });
            continue;
        }

        const hp = block.halfblockPlacement ?? 0;
        const rot = block.rot ?? 1;
        const isSlab = block.model === "Slab";

        let facesCreated = 0;
        for (let face = 0; face < 6; face++) {
            let scaling = new BABYLON.Vector3(1, 1, 1);
            let offset = new BABYLON.Vector3(0, 0, 0);
            let modelRot = new BABYLON.Vector3(0, 0, 0);

            if (isSlab) {
                scaling.y = 0.5;
                if (hp === 0) { // Top (Bloxd 0)
                    offset.y = 0.25;
                } else if (hp === 1) { // Bottom (Bloxd 1)
                    offset.y = -0.25;
                } else if (hp === 2) { // Side (Bloxd 2)
                    modelRot.x = Math.PI / 2;
                    if (rot === 1) { offset.z = -0.25; modelRot.y = 0; }
                    else if (rot === 2) { offset.x = -0.25; modelRot.y = -Math.PI / 2; }
                    else if (rot === 3) { offset.z = 0.25; modelRot.y = Math.PI; }
                    else if (rot === 4) { offset.x = 0.25; modelRot.y = Math.PI / 2; }
                }
            }

            const texIndex = FACE_MAP[face];
            const texName = Array.isArray(block.textureInfo) ? block.textureInfo[texIndex] : block.textureInfo;
            if (!texName) continue;

            const mat = new BABYLON.StandardMaterial(`mat_${blockId}_f${face}`, scene);
            const tex = await getRotatedTexture(texName, FACE_ROTATION[face] ?? 0);
            if (tex) { mat.diffuseTexture = tex; mat.diffuseTexture.hasAlpha = true; }
            else { mat.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8); }
            mat.disableLighting = true;
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.backFaceCulling = true;
            mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;

            const faceMesh = createFaceMesh(face, mat, scaling, offset);
            if (modelRot.length() > 0) {
                const rotMat = BABYLON.Matrix.RotationYawPitchRoll(modelRot.y, modelRot.x, modelRot.z);
                faceMesh.bakeTransformIntoVertices(rotMat);
            }

            const matricesData = new Float32Array(positions.length * 16);
            for (let i = 0; i < positions.length; i++) {
                BABYLON.Matrix.Translation(positions[i].x, positions[i].y, positions[i].z).copyToArray(matricesData, i * 16);
            }
            faceMesh.thinInstanceSetBuffer("matrix", matricesData, 16);
            facesCreated++;
        }
        if (facesCreated > 0) {
            blockStats.set(blockId, { status: "SUCCESS", count: positions.length, name: block.name });
            totalPlaced += positions.length;
        }
    }
    log(`[BUILD] DONE. Total: ${totalPlaced}`);
}

function clearScene() {
    scene.meshes.slice().forEach(m => m.dispose());
    textureCache.clear();
}

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => { engine.resize(); updateOrtho(camera.orthoTop); });

document.getElementById("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await initAssets();
    const schem = await parseSchem(file);
    log(`[SCHEM] ${schem.name}`);
    await buildSchem(schem);
});

log(`BloxdSchemViewer ${VERSION} ready.`);
