const VERSION = "alpha-0.37-slab-rotation-motion-fix";

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
    100,
    new BABYLON.Vector3(0, 0, 0),
    scene
);
camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
camera.attachControl(canvas, true, false); // Disable default zoom to handle it manually
camera.minZ = -1000;
camera.maxZ = 1000;

// Custom Zoom for Orthographic Camera
canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const zoomSpeed = 0.1;
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
light.intensity = 2;

const textureData = {};
const textureCache = new Map();
let blockMap = {};
let currentSchemBlocks = [];
let isAssetsLoaded = false;

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
        log("[TEXTURE] Found", pngMap.size, "filename mappings");

        const idToDataRegex = /(\d+)\s*:\s*[^=]*?=>\s*\{[^}]*?exports\s*=\s*"(data:image\/png;base64,[^"]+)"/g;
        const idToData = new Map();
        while ((m = idToDataRegex.exec(src)) !== null) {
            idToData.set(parseInt(m[1]), m[2]);
        }
        log("[TEXTURE] Found", idToData.size, "base64 modules");

        let count = 0;
        pngMap.forEach((id, name) => {
            if (idToData.has(id)) {
                textureData[name] = idToData.get(id);
                count++;
            }
        });

        if (count < 100) {
            log("[TEXTURE] Low mapping count, trying fallback data extraction...");
            const fallbackDataRegex = /(\d+)\s*:\s*.*?exports\s*=\s*"(data:image\/png;base64,[^"]+)"/g;
            while ((m = fallbackDataRegex.exec(src)) !== null) {
                const id = parseInt(m[1]);
                if (!idToData.has(id)) {
                    idToData.set(id, m[2]);
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

async function initAssets() {
    if (isAssetsLoaded) return;
    log("[INIT] Loading assets...");
    await extractTextures();
    await loadBlockData();
    isAssetsLoaded = true;
    log("[INIT] Assets ready");
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
    let currentIndex = 0;
    while (state.offset < bytes.length) {
        const skip = readULEB(bytes, state);
        currentIndex += skip;
        if (state.offset >= bytes.length) break;
        const id = readULEB(bytes, state);
        if (currentIndex < arr.length) {
            arr[currentIndex] = id;
        }
        currentIndex += 1; // Move to next position after placing a block
    }
    return arr;
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

function createFaceMesh(faceIndex, material, scaling, offset) {
    // Create a plane that will be one side of the (possibly squashed) box
    // The size of the plane depends on which face it is
    let width = 1, height = 1;
    switch(faceIndex) {
        case 0: case 1: width = scaling.x; height = scaling.y; break; // Front/Back
        case 2: case 3: width = scaling.z; height = scaling.y; break; // Right/Left
        case 4: case 5: width = scaling.x; height = scaling.z; break; // Top/Bottom
    }

    const plane = BABYLON.MeshBuilder.CreatePlane(`face_${faceIndex}`, { width, height }, scene);
    plane.material = material;

    switch(faceIndex) {
        case 0: // Front (Z-)
            plane.rotation.y = 0; 
            plane.position.set(offset.x, offset.y, -0.5 * scaling.z + offset.z); 
            break;
        case 1: // Back (Z+)
            plane.rotation.y = Math.PI; 
            plane.position.set(offset.x, offset.y, 0.5 * scaling.z + offset.z); 
            break;
        case 2: // Right (X+)
            plane.rotation.y = -Math.PI / 2; 
            plane.position.set(0.5 * scaling.x + offset.x, offset.y, offset.z); 
            break;
        case 3: // Left (X-)
            plane.rotation.y = Math.PI / 2; 
            plane.position.set(-0.5 * scaling.x + offset.x, offset.y, offset.z); 
            break;
        case 4: // Top (Y+)
            plane.rotation.x = Math.PI / 2; 
            plane.position.set(offset.x, 0.5 * scaling.y + offset.y, offset.z); 
            break;
        case 5: // Bottom (Y-)
            plane.rotation.x = -Math.PI / 2; 
            plane.position.set(offset.x, -0.5 * scaling.y + offset.y, offset.z); 
            break;
    }
    plane.bakeCurrentTransformIntoVertices();
    return plane;
}

async function buildSchem(schem) {
    clearScene();
    log("[BUILD] starting...");
    const blockPositions = new Map();
    const blockStats = new Map(); // Track status of every block ID

    for (const chunk of schem.chunks) {
        const decoded = decodeBlocks(new Uint8Array(chunk.blocks));
        for (let i = 0; i < decoded.length; i++) {
            const rawId = decoded[i];
            if (rawId === 0) continue;
            const blockId = rawId - 1;
            const pos = idxToXYZ(i);
            // Based on もどす.html and user feedback, chunk.z is depth, chunk.x is width
            const worldPos = new BABYLON.Vector3(
                chunk.z * 32 + pos.z, 
                chunk.y * 32 + pos.y, 
                chunk.x * 32 + pos.x
            );
            currentSchemBlocks.push({ id: blockId, x: worldPos.x, y: worldPos.y, z: worldPos.z });
            if (!blockPositions.has(blockId)) blockPositions.set(blockId, []);
            blockPositions.get(blockId).push(worldPos);
        }
    }
    window.currentSchemBlocks = currentSchemBlocks;
    
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

        // Slab logic with physical rotation motion
        let currentScaling = new BABYLON.Vector3(1, 1, 1);
        let currentOffset = new BABYLON.Vector3(0, 0, 0);
        let modelRotation = new BABYLON.Vector3(0, 0, 0);
        let faceToTexMap = [...FACE_MAP];

        if (block.model === "Slab") {
            const hp = block.halfblockPlacement ?? 0;
            if (hp === 0) { // Bottom
                currentScaling.y = 0.5; currentOffset.y = -0.25;
            } else if (hp === 1) { // Top
                currentScaling.y = 0.5; currentOffset.y = 0.25;
            } else if (hp === 2) { // Side (Rotation Motion)
                const rot = block.rot ?? 1;
                // Start with a "Top Slab" and rotate it
                currentScaling.y = 0.5;
                if (rot === 1) { // Z- (Rotate around X axis)
                    modelRotation.x = Math.PI / 2;
                    currentOffset.z = -0.25;
                } else if (rot === 2) { // X- (Rotate around Z axis)
                    modelRotation.z = Math.PI / 2;
                    currentOffset.x = -0.25;
                } else if (rot === 3) { // Z+ (Rotate around X axis)
                    modelRotation.x = -Math.PI / 2;
                    currentOffset.z = 0.25;
                } else if (rot === 4) { // X+ (Rotate around Z axis)
                    modelRotation.z = -Math.PI / 2;
                    currentOffset.x = 0.25;
                }
                // Remap textures to follow the rotation
                if (rot === 1 || rot === 3) faceToTexMap = [2, 3, 1, 0, 4, 5];
                if (rot === 2 || rot === 4) faceToTexMap = [1, 0, 2, 3, 4, 5];
            }
        }

        let facesCreated = 0;
        for (let face = 0; face < 6; face++) {
            const texIndex = faceToTexMap[face];
            const texName = Array.isArray(textureInfo) ? textureInfo[texIndex] : textureInfo;
            if (!texName) continue;

            const rot = FACE_ROTATION[face] ?? 0;
            const mat = new BABYLON.StandardMaterial(`mat_${blockId}_f${face}`, scene);
            const tex = await getRotatedTexture(texName, rot);
            if (!tex) {
                mat.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.8);
            } else {
                mat.diffuseTexture = tex;
                mat.diffuseTexture.hasAlpha = true;
            }
            mat.disableLighting = true;
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.backFaceCulling = true;
            mat.alphaMode = BABYLON.Engine.ALPHA_COMBINE;

            const faceMesh = createFaceMesh(face, mat, currentScaling, currentOffset);
            
            // Apply model-level rotation if any
            if (modelRotation.length() > 0) {
                const rotationMatrix = BABYLON.Matrix.RotationYawPitchRoll(modelRotation.y, modelRotation.x, modelRotation.z);
                faceMesh.bakeTransformIntoVertices(rotationMatrix);
            }

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
        } else {
            blockStats.set(blockId, { status: "FAILED", reason: "No faces created (empty textureInfo?)", count: positions.length, name: block.name });
        }
    }
    
    // Detailed summary log
    log("[BUILD SUMMARY]");
    blockStats.forEach((stat, id) => {
        const nameStr = stat.name ? ` (${stat.name})` : "";
        const modelStr = stat.model ? ` [Model: ${stat.model}]` : "";
        if (stat.status === "SUCCESS") {
            log(` ✅ ID ${id}${nameStr}${modelStr}: ${stat.count} blocks placed`);
        } else {
            log(` ❌ ID ${id}${nameStr}: FAILED - ${stat.reason} (${stat.count} blocks skipped)`);
        }
    });
    
    log("[DONE] total blocks placed:", totalPlaced);
    
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
        await initAssets();
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

// Pre-load assets
initAssets();

log("[READY]");
