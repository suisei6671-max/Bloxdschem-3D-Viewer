const VERSION = "alpha-0.32-texture-fix";

const logEl = document.getElementById("log");

function log(...a) {
    console.log(...a);
    if (logEl) {
        logEl.textContent += a.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" ") + "\n";
        logEl.scrollTop = logEl.scrollHeight;
    }
}

log("[BOOT]", VERSION);

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, {
    antialias: false,
    preserveDrawingBuffer: true,
    stencil: true
});

const scene = new BABYLON.Scene(engine);
scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

const camera = new BABYLON.ArcRotateCamera(
    "cam",
    Math.PI / 4,
    Math.atan(Math.SQRT2),
    40,
    new BABYLON.Vector3(0, 0, 0),
    scene
);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
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
let currentSchemBlocks = [];

const FACE_MAP = [4, 5, 1, 0, 2, 3];

const FACE_ROTATION = {
    0: 0,  // front
    1: 0,  // back
    2: 0,  // right
    3: 0,  // left
    4: -90, // top
    5: -90  // bottom
};

async function extractTextures() {
    try {
        log("[TEXTURE] Fetching images.js...");
        const res = await fetch("./images.js");
        const src = await res.text();
        
        // 1. Extract filename to module ID mapping from "案内モジュール"
        // These are inside objects like var SF = { "./allium.png": 3190, ... }
        // We look for patterns like "./name.png": 1234
        const pngToIdRegex = /"\.\/([^"]+?)\.png"\s*:\s*(\d+)/g;
        const pngMap = new Map();
        let m;
        while ((m = pngToIdRegex.exec(src)) !== null) {
            const fullPath = m[1];
            const filename = fullPath.split('/').pop(); // e.g., "allium" from "./allium.png"
            const id = parseInt(m[2]);
            
            // Map both the filename and the full path to the ID
            pngMap.set(filename, id);
            pngMap.set(fullPath, id);
        }
        log("[TEXTURE] Found", pngMap.size, "filename mappings");

        // 2. Extract module ID to base64 mapping from "データモジュール"
        // Format: 3190: FF => { FF.exports = "data:image/png;base64,..." }
        // We need to be careful with the regex to capture the ID and the data string
        const idToDataRegex = /(\d+)\s*:\s*[^=]*?=>\s*\{[^}]*?exports\s*=\s*"(data:image\/png;base64,[^"]+)"/g;
        const idToData = new Map();
        while ((m = idToDataRegex.exec(src)) !== null) {
            idToData.set(parseInt(m[1]), m[2]);
        }
        log("[TEXTURE] Found", idToData.size, "base64 modules");

        // 3. Map them together
        let count = 0;
        pngMap.forEach((id, name) => {
            if (idToData.has(id)) {
                textureData[name] = idToData.get(id);
                count++;
            }
        });

        // Fallback: If some textures are still missing, try a simpler regex for data modules
        if (count < 100) {
            log("[TEXTURE] Low mapping count, trying fallback data extraction...");
            const fallbackDataRegex = /(\d+)\s*:\s*.*?exports\s*=\s*"(data:image\/png;base64,[^"]+)"/g;
            while ((m = fallbackDataRegex.exec(src)) !== null) {
                const id = parseInt(m[1]);
                if (!idToData.has(id)) {
                    idToData.set(id, m[2]);
                    // Check if this new ID helps any existing mappings
                    pngMap.forEach((mappedId, name) => {
                        if (mappedId === id && !textureData[name]) {
                            textureData[name] = m[2];
                            count++;
                        }
                    });
                }
            }
        }

        log("[TEXTURE] Successfully mapped", count, "textures");
    } catch (e) { log("[TEXTURE ERROR]", e.message); }
}

async function loadBlockData() {
    try {
        const res = await fetch("./blockData.json");
        const json = await res.json();
        blockMap = {};
        if (Array.isArray(json)) {
            for (let i = 0; i < json.length; i++) blockMap[i] = json[i];
        } else {
            blockMap = json;
        }
        log("[BLOCK DATA] Loaded", Object.keys(blockMap).length, "entries");
    } catch (e) { log("[BLOCK DATA ERROR]", e.message); }
}

async function getRotatedTexture(name, deg) {
    const key = `${name}_rot_${deg}`;
    if (textureCache.has(key)) return textureCache.get(key);
    const src = textureData[name];
    if (!src) {
        // log("[TEXTURE MISSING]", name);
        return null;
    }
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

function clearScene() {
    scene.meshes.slice().forEach(m => m.dispose());
    textureCache.clear();
    currentSchemBlocks = [];
}

function readULEB(bytes, state) {
    let result = 0; let shift = 0;
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
    return { x: i % 32, y: Math.floor(i / 32) % 32, z: Math.floor(i / 1024) };
}

async function parseSchem(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let offset = 4;
    function readVarInt() {
        let shift = 0; let result = 0;
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
            schem.chunks.push({ x: readVarInt(), y: readVarInt(), z: readVarInt(), blocks: readBytes() });
        }
    }
    return schem;
}

function createFaceMesh(faceIndex, material) {
    const plane = BABYLON.MeshBuilder.CreatePlane(`face_${faceIndex}`, { size: 1 }, scene);
    plane.material = material;
    switch(faceIndex) {
        case 0: plane.rotation.y = 0; plane.position.z = -0.5; break;
        case 1: plane.rotation.y = Math.PI; plane.position.z = 0.5; break;
        case 2: plane.rotation.y = -Math.PI / 2; plane.position.x = 0.5; break;
        case 3: plane.rotation.y = Math.PI / 2; plane.position.x = -0.5; break;
        case 4: plane.rotation.x = Math.PI / 2; plane.position.y = 0.5; break;
        case 5: plane.rotation.x = -Math.PI / 2; plane.position.y = -0.5; break;
    }
    plane.bakeCurrentTransformIntoVertices();
    return plane;
}

async function buildSchem(schem) {
    clearScene();
    log("[BUILD] starting...");
    const blockPositions = new Map();
    for (const chunk of schem.chunks) {
        const decoded = decodeBlocks(new Uint8Array(chunk.blocks));
        for (let i = 0; i < decoded.length; i++) {
            const rawId = decoded[i];
            if (rawId === 0) continue;
            const blockId = rawId - 1;
            const pos = idxToXYZ(i);
            const worldPos = new BABYLON.Vector3(chunk.z * 32 + pos.z, chunk.y * 32 + pos.y, chunk.x * 32 + pos.x);
            currentSchemBlocks.push({ id: blockId, x: worldPos.x, y: worldPos.y, z: worldPos.z });
            if (!blockPositions.has(blockId)) blockPositions.set(blockId, []);
            blockPositions.get(blockId).push(worldPos);
        }
    }
    window.currentSchemBlocks = currentSchemBlocks;
    
    let totalPlaced = 0;
    for (const [blockId, positions] of blockPositions) {
        const block = blockMap[blockId];
        if (!block) continue;
        
        const textureInfo = block.textureInfo;
        if (!textureInfo) continue;

        for (let face = 0; face < 6; face++) {
            const bloxdFace = FACE_MAP[face];
            // New logic: textureInfo is now a 6-element array matching FACE_MAP order
            const texName = Array.isArray(textureInfo) ? textureInfo[bloxdFace] : textureInfo;
            if (!texName) continue;

            const rot = FACE_ROTATION[face] ?? 0;
            const mat = new BABYLON.StandardMaterial(`mat_${blockId}_f${face}`, scene);
            const tex = await getRotatedTexture(texName, rot);
            if (!tex) {
                // Fallback color if texture missing
                mat.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
            } else {
                mat.diffuseTexture = tex;
                mat.diffuseTexture.hasAlpha = true;
            }
            mat.disableLighting = true;
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.backFaceCulling = true;
            mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;

            const faceMesh = createFaceMesh(face, mat);
            const matricesData = new Float32Array(positions.length * 16);
            for (let i = 0; i < positions.length; i++) {
                const matrix = BABYLON.Matrix.Translation(positions[i].x, positions[i].y, positions[i].z);
                matrix.copyToArray(matricesData, i * 16);
            }
            faceMesh.thinInstanceSetBuffer("matrix", matricesData, 16);
        }
        totalPlaced += positions.length;
    }
    log("[DONE] total blocks:", totalPlaced);
    
    const bounds = getModelWorldBounds();
    if (bounds) {
        const center = BABYLON.Vector3.Center(bounds.min, bounds.max);
        camera.setTarget(center);
        const size = bounds.max.subtract(bounds.min).length();
        updateOrtho(size * 0.8);
    }
}

function updateOrtho(val) {
    const w = canvas.width || 800;
    const h = canvas.height || 600;
    const aspect = w / h;
    camera.orthoTop = val;
    camera.orthoBottom = -val;
    camera.orthoLeft = -val * aspect;
    camera.orthoRight = val * aspect;
}

function getModelWorldBounds() {
    let min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
    let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
    let found = false;
    scene.meshes.forEach(m => {
        if (!m.isEnabled() || !m.isVisible || m.getTotalVertices() === 0) return;
        const matrices = m.thinInstanceGetWorldMatrices();
        if (matrices && matrices.length > 0) {
            const localMin = m.getBoundingInfo().boundingBox.minimum;
            const localMax = m.getBoundingInfo().boundingBox.maximum;
            matrices.forEach(matrix => {
                const worldMin = BABYLON.Vector3.TransformCoordinates(localMin, matrix);
                const worldMax = BABYLON.Vector3.TransformCoordinates(localMax, matrix);
                min = BABYLON.Vector3.Minimize(min, worldMin);
                min = BABYLON.Vector3.Minimize(min, worldMax);
                max = BABYLON.Vector3.Maximize(max, worldMin);
                max = BABYLON.Vector3.Maximize(max, worldMax);
                found = true;
            });
        }
    });
    return found ? { min, max } : null;
}

async function instantCapture() {
    log("[CAPTURE] starting...");
    const oldAlpha = camera.alpha;
    const oldBeta = camera.beta;
    const oldOrthoTop = camera.orthoTop;
    const oldOrthoBottom = camera.orthoBottom;
    const oldOrthoLeft = camera.orthoLeft;
    const oldOrthoRight = camera.orthoRight;

    const style = document.querySelector('input[name="angleStyle"]:checked').value;
    if (style === "wiki") {
        camera.alpha = -0.785398;
        camera.beta = 1.0472;
    } else {
        camera.alpha = Math.PI / 4;
        camera.beta = Math.atan(Math.SQRT2);
    }
    
    const bounds = getModelWorldBounds();
    let captureBaseSize = 1024;
    if (bounds) {
        camera.setTarget(BABYLON.Vector3.Center(bounds.min, bounds.max));
        const size = bounds.max.subtract(bounds.min).length();
        const captureOrtho = size * 1.5; 
        camera.orthoTop = captureOrtho;
        camera.orthoBottom = -captureOrtho;
        camera.orthoLeft = -captureOrtho;
        camera.orthoRight = captureOrtho;
        if (size > 32) captureBaseSize = 2048;
        if (size > 64) captureBaseSize = 4096;
    }

    const CAPTURE_SIZE = captureBaseSize; 
    log("[CAPTURE] resolution:", CAPTURE_SIZE);
    
    const rtt = new BABYLON.RenderTargetTexture("highResRTT", CAPTURE_SIZE, scene, false, true);
    rtt.renderList = scene.meshes.filter(m => m.isEnabled() && m.isVisible);
    rtt.activeCamera = camera;
    rtt.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    
    scene.render();
    rtt.render();
    
    rtt.readPixels().then((pixels) => {
        let minX = CAPTURE_SIZE, maxX = 0, minY = CAPTURE_SIZE, maxY = 0;
        let found = false;
        for (let y = 0; y < CAPTURE_SIZE; y++) {
            for (let x = 0; x < CAPTURE_SIZE; x++) {
                const alpha = pixels[(y * CAPTURE_SIZE + x) * 4 + 3];
                if (alpha > 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    found = true;
                }
            }
        }

        if (!found) {
            log("[CAPTURE ERROR] No content found");
            rtt.dispose();
            return;
        }

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = CAPTURE_SIZE; tempCanvas.height = CAPTURE_SIZE;
        const tempCtx = tempCanvas.getContext("2d");
        const imgData = tempCtx.createImageData(CAPTURE_SIZE, CAPTURE_SIZE);
        for (let y = 0; y < CAPTURE_SIZE; y++) {
            for (let x = 0; x < CAPTURE_SIZE; x++) {
                const sourceIndex = (y * CAPTURE_SIZE + x) * 4;
                const targetIndex = ((CAPTURE_SIZE - 1 - y) * CAPTURE_SIZE + x) * 4;
                imgData.data[targetIndex] = pixels[sourceIndex];
                imgData.data[targetIndex + 1] = pixels[sourceIndex + 1];
                imgData.data[targetIndex + 2] = pixels[sourceIndex + 2];
                imgData.data[targetIndex + 3] = pixels[sourceIndex + 3];
            }
        }
        tempCtx.putImageData(imgData, 0, 0);
        const finalW = maxX - minX + 1;
        const finalH = maxY - minY + 1;
        const correctedMinY = CAPTURE_SIZE - maxY - 1;
        const saveCanvas = document.createElement("canvas");
        saveCanvas.width = finalW; saveCanvas.height = finalH;
        const ctx = saveCanvas.getContext("2d");
        ctx.drawImage(tempCanvas, minX, correctedMinY, finalW, finalH, 0, 0, finalW, finalH);
        const link = document.createElement("a");
        link.download = `bloxdschem_capture_${style}.png`;
        link.href = saveCanvas.toDataURL("image/png");
        link.click();
        camera.alpha = oldAlpha;
        camera.beta = oldBeta;
        camera.orthoTop = oldOrthoTop;
        camera.orthoBottom = oldOrthoBottom;
        camera.orthoLeft = oldOrthoLeft;
        camera.orthoRight = oldOrthoRight;
        rtt.dispose();
        log("[CAPTURE] done");
    });
}

document.getElementById("buildBtn").onclick = async () => {
    try {
        log("[START]");
        await extractTextures();
        await loadBlockData();
        const file = document.getElementById("schemInput").files[0];
        if (!file) { alert("schemファイルを選択してください"); return; }
        const schem = await parseSchem(file);
        log("[SCHEM]", schem.name);
        await buildSchem(schem);
    } catch (e) { console.error(e); log("[ERROR]", e.message); }
};

window.instantCapture = instantCapture;
engine.runRenderLoop(() => { scene.render(); });
window.addEventListener("resize", () => { engine.resize(); updateOrtho(camera.orthoTop || 10); });
updateOrtho(10);
log("[READY]");
