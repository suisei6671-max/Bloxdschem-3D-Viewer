const VERSION = "alpha-0.41-build-fix";

const logEl = document.getElementById("log");

function log(...a) {
    const s = a.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" ");
    console.log(s);
    if (logEl) {
        logEl.innerText += s + "\n";
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// Load avsc and Buffer from esm.sh
import avsc from "https://esm.sh/avsc@5.7.4";
import { Buffer } from "https://esm.sh/buffer@6.0.3";
window.Buffer = Buffer;

const schema = avsc.Type.forSchema({
    type: "record",
    name: "Schematic",
    fields: [
        { name: "name", type: "string" },
        { name: "x", type: "int" },
        { name: "y", type: "int" },
        { name: "z", type: "int" },
        { name: "sizeX", type: "int" },
        { name: "sizeY", type: "int" },
        { name: "sizeZ", type: "int" },
        {
            name: "chunks",
            type: {
                type: "array",
                items: {
                    type: "record",
                    fields: [
                        { name: "x", type: "int" },
                        { name: "y", type: "int" },
                        { name: "z", type: "int" },
                        { name: "blocks", type: "bytes" }
                    ]
                }
            }
        }
    ]
});

const canvas = document.getElementById("renderCanvas");
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

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
    new BABYLON.Vector3(0.5, 1, 0.2),
    scene
);
light.intensity = 1.8;

// Assets
let blockMap = {};
let textureData = {};
let textureCache = new Map();
let isAssetsLoaded = false;

async function extractTextures() {
    try {
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
        log(`[TEXTURE] Successfully mapped ${count} textures.`);
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

function decodeBlocks(chunk) {
    let i = 0;
    const data = chunk.blocks;
    const blocks = [];
    function leb() {
        let shift = 0, value = 0;
        while (true) {
            const byte = data[i++];
            value |= (byte & 127) << shift;
            shift += 7;
            if (!(byte & 128)) break;
        }
        return value;
    }
    while (i < data.length) {
        const count = leb();
        const id = leb();
        for (let j = 0; j < count; j++) blocks.push(id);
    }
    return blocks;
}

async function parseSchem(file) {
    const arrayBuffer = await file.arrayBuffer();
    const full = new Uint8Array(arrayBuffer);
    const sliced = full.slice(4);
    const buffer = Buffer.from(sliced);
    const data = schema.fromBuffer(buffer, undefined, true);

    const blocks = [];
    for (const c of data.chunks) {
        const arr = decodeBlocks(c);
        let i = 0;
        for (let x = 0; x < 32; x++) {
            for (let y = 0; y < 32; y++) {
                for (let z = 0; z < 32; z++) {
                    const id = arr[i++];
                    if (id === 0) continue;
                    blocks.push({
                        x: c.x * 32 + x,
                        y: c.y * 32 + y,
                        z: c.z * 32 + z,
                        id: id
                    });
                }
            }
        }
    }
    return { name: data.name, blocks: blocks };
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

        if (isSlab && positions.length > 0) {
            log(`[DEBUG] Slab ID ${blockId}: hp=${hp}, rot=${rot}`);
        }

        let facesCreated = 0;
        for (let face = 0; face < 6; face++) {
            let scaling = new BABYLON.Vector3(1, 1, 1);
            let offset = new BABYLON.Vector3(0, 0, 0);
            let modelRot = new BABYLON.Vector3(0, 0, 0);

            if (isSlab) {
                // All slabs start as a Top Slab (height 0.5, y=0.25)
                scaling.y = 0.5;
                
                if (hp === 0) { // top
                    offset.y = 0.25;
                } else if (hp === 1) { // bottom
                    offset.y = -0.25;
                } else if (hp === 2) { // side
                    // Base: Top Slab
                    offset.y = 0.25;
                    // Rotate to side
                    if (rot === 1) { // Z- (Front)
                        modelRot.x = -Math.PI / 2;
                    } else if (rot === 2) { // X- (Left)
                        modelRot.z = Math.PI / 2;
                    } else if (rot === 3) { // Z+ (Back)
                        modelRot.x = Math.PI / 2;
                    } else if (rot === 4) { // X+ (Right)
                        modelRot.z = -Math.PI / 2;
                    }
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

    // Auto center
    if (totalPlaced > 0) {
        const min = new BABYLON.Vector3(Infinity, Infinity, Infinity);
        const max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
        for (const b of schem.blocks) {
            min.x = Math.min(min.x, b.x); min.y = Math.min(min.y, b.y); min.z = Math.min(min.z, b.z);
            max.x = Math.max(max.x, b.x); max.y = Math.max(max.y, b.y); max.z = Math.max(max.z, b.z);
        }
        const center = min.add(max).scale(0.5);
        camera.setTarget(center);
        const size = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
        updateOrtho(size * 0.8 + 2);
    }
}

function clearScene() {
    scene.meshes.slice().forEach(m => m.dispose());
    textureCache.clear();
}

engine.runRenderLoop(() => scene.render());

// Angle Style
document.getElementsByName("angleStyle").forEach(radio => {
    radio.addEventListener("change", (e) => {
        if (e.target.value === "wiki") {
            camera.alpha = Math.PI / 4;
            camera.beta = Math.atan(1 / Math.sqrt(2));
        } else {
            camera.alpha = Math.PI / 4;
            camera.beta = Math.atan(Math.SQRT2);
        }
    });
});

// Capture Logic
window.instantCapture = async () => {
    log("[CAPTURE] Starting...");
    const oldColor = scene.clearColor;
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);
    
    // Higher res for better quality before crop
    const screenshot = await BABYLON.Tools.CreateScreenshotAsync(engine, camera, { precision: 2 });
    scene.clearColor = oldColor;

    const img = new Image();
    img.src = screenshot;
    img.onload = () => {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const ctx = tempCanvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;
        let minX = tempCanvas.width, minY = tempCanvas.height, maxX = 0, maxY = 0;
        let found = false;

        for (let y = 0; y < tempCanvas.height; y++) {
            for (let x = 0; x < tempCanvas.width; x++) {
                const alpha = data[(y * tempCanvas.width + x) * 4 + 3];
                if (alpha > 0) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                    found = true;
                }
            }
        }

        if (!found) {
            log("[CAPTURE] Failed: Image is empty.");
            return;
        }

        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;
        const finalCanvas = document.createElement("canvas");
        finalCanvas.width = cropWidth;
        finalCanvas.height = cropHeight;
        const finalCtx = finalCanvas.getContext("2d");
        finalCtx.drawImage(tempCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
        
        const link = document.createElement("a");
        link.download = `capture_${Date.now()}.png`;
        link.href = finalCanvas.toDataURL("image/png");
        link.click();
        log("[CAPTURE] Done.");
    };
};

// Listeners
document.getElementById("schemInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await initAssets();
    const schem = await parseSchem(file);
    log(`[SCHEM] ${schem.name}`);
    await buildSchem(schem);
});

document.getElementById("buildBtn").addEventListener("click", async () => {
    const input = document.getElementById("schemInput");
    if (input.files.length > 0) {
        const file = input.files[0];
        await initAssets();
        const schem = await parseSchem(file);
        await buildSchem(schem);
    } else {
        alert("Please select a file first.");
    }
});

log(`BloxdSchemViewer ${VERSION} ready.`);
