import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createPointCloud } from "./dummy_points.js";
import {
    BOX_CLASS_COLORS,
    decodeQuantizedFrame,
    decodeBoxCorner,
    parseSceneChunkBuffer,
    parseScenesConfig,
} from "./scene_chunks.js";
import { writeEventColors } from "./event_colors.js?v=20260903-0005";
import { EVENT_MODELS, selectEventDeltas } from "./event_model.js";
import { togglePlaybackState } from "./playback_state.js";
import { turbo } from "./turbo.js";

const SCENES_URL = "static/data/scenes.json";
const MIN_FLY_TARGET_DISTANCE = 5.0;
const MIN_FLY_STEP = 1.0;
const SCENE_LOAD_LIMIT = 10;
const DEFAULT_CHUNK_EXTENSION = ".bin";
const GRID_GROUND_Z = -1.8;
const HEIGHT_VALUE_RANGE = [-2.0, 2.0];
const BOX_EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
];

function showWebGLError(container) {
    container.classList.add("viewer-fallback");
    container.textContent = "This interactive viewer requires WebGL, which is not available in your browser.";
}

async function fetchJson(url, signal = undefined) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

async function loadScenes() {
    return parseScenesConfig(await fetchJson(SCENES_URL));
}

async function loadSceneManifest(scene, signal = undefined) {
    const manifest = await fetchJson(`${scene.dir}/manifest.json`, signal);
    if (!manifest || typeof manifest !== "object") {
        throw new Error(`Invalid manifest: ${scene.dir}`);
    }
    if (!Number.isInteger(manifest.frameCount) || !Number.isInteger(manifest.chunkCount)) {
        throw new Error(`Manifest frame/chunk count is invalid: ${scene.dir}`);
    }
    if (!Array.isArray(manifest.valueRange) || manifest.valueRange.length !== 2) {
        throw new Error(`Manifest valueRange is invalid: ${scene.dir}`);
    }
    return manifest;
}

function sceneChunkUrl(scene, chunkIndex) {
    return `${scene.dir}/chunk_${String(chunkIndex).padStart(2, "0")}${DEFAULT_CHUNK_EXTENSION}`;
}

async function fetchSceneChunkBuffer(scene, chunkIndex, signal = undefined) {
    const chunkUrl = sceneChunkUrl(scene, chunkIndex);
    const fetchStart = performance.now();
    const response = await fetch(chunkUrl, { signal });
    if (!response.ok) {
        throw new Error(`${chunkUrl}: ${response.status} ${response.statusText}`);
    }
    const wireBuffer = await response.arrayBuffer();
    const fetchMs = performance.now() - fetchStart;

    return {
        buffer: wireBuffer,
        metrics: {
            url: chunkUrl,
            chunkIndex,
            wireBytes: wireBuffer.byteLength,
            payloadBytes: wireBuffer.byteLength,
            fetchMs,
            decompressMs: 0,
        },
    };
}

async function loadSceneChunk(scene, chunkIndex, signal = undefined, metricsSink = null) {
    const chunk = await fetchSceneChunkBuffer(scene, chunkIndex, signal);
    if (metricsSink) {
        metricsSink.push(chunk.metrics);
    }
    return parseSceneChunkBuffer(chunk.buffer);
}

async function loadInitialSceneData() {
    const scenes   = await loadScenes();
    const scene    = scenes[0];
    const manifest = await loadSceneManifest(scene);
    const chunkMetrics = [];
    const frames       = await loadSceneChunk(scene, 0, undefined, chunkMetrics);
    if (frames.length === 0) {
        throw new Error(`Scene has an empty first chunk: ${scene.dir}`);
    }

    const firstFrame = frames[0];
    return {
        source: "real",
        scenes,
        scene,
        manifest,
        pointCloud: decodeQuantizedFrame(firstFrame, manifest.valueRange),
        initialFrame: firstFrame,
        initialFrames: frames,
        boxes: firstFrame.boxes,
        chunkMetrics,
    };
}

async function loadViewerInitialData() {
    try {
        return await loadInitialSceneData();
    } catch (error) {
        console.warn("Could not load scene data. Using a synthetic point cloud instead.", error);
        return {
            source: "dummy",
            scenes: [],
            scene: null,
            manifest: null,
            pointCloud: createPointCloud(),
            initialFrame: null,
            boxes: null,
            chunkMetrics: [],
        };
    }
}

function activeColorRange(state) {
    return state.colorMode === "height" ? HEIGHT_VALUE_RANGE : state.valueRange;
}

function activeDeltas(state) {
    return selectEventDeltas(state.eventModel, state.currentQuantizedFrame, state.currentValues);
}

function turboCssColor(t) {
    const [r, g, b] = turbo(t);
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function formatValueLabel(value) {
    return `${value >= 0 ? "+" : ""}${value.toFixed(1)} m`;
}

function setupColorbar(state) {
    const gradient = document.getElementById("viewer-colorbar-gradient");
    const minLabel = document.getElementById("viewer-colorbar-min");
    const maxLabel = document.getElementById("viewer-colorbar-max");
    const title = document.getElementById("viewer-colorbar-title");

    if (!gradient || !minLabel || !maxLabel) {
        return;
    }

    const stops = [];
    for (let i = 0; i <= 10; i += 1) {
        const t = i / 10;
        stops.push(`${turboCssColor(t)} ${i * 10}%`);
    }

    gradient.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
    const valueRange = activeColorRange(state);
    minLabel.textContent = formatValueLabel(valueRange[0]);
    maxLabel.textContent = formatValueLabel(valueRange[1]);
    if (title) {
        title.textContent = state.colorMode === "height" ? "Height [m]" : "Temporal diff. Δ [m]";
    }
}

function createPointAlphaMap() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;

    const context = canvas.getContext("2d");
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(32, 32, 30, 0, Math.PI * 2);
    context.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
}

function createConcentricCircleGuide() {
    const radiusStep = 5;
    const circleCount = 40;
    const segments = 96;
    const maxRadius = radiusStep * circleCount;
    const positions = new Float32Array((circleCount * segments * 2 + 4) * 3);
    let offset = 0;

    for (let circleIndex = 1; circleIndex <= circleCount; circleIndex += 1) {
        const radius = circleIndex * radiusStep;
        for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
            const angle0 = (segmentIndex / segments) * Math.PI * 2;
            const angle1 = ((segmentIndex + 1) / segments) * Math.PI * 2;
            positions[offset] = radius * Math.cos(angle0);
            positions[offset + 1] = radius * Math.sin(angle0);
            positions[offset + 2] = 0;
            positions[offset + 3] = radius * Math.cos(angle1);
            positions[offset + 4] = radius * Math.sin(angle1);
            positions[offset + 5] = 0;
            offset += 6;
        }
    }
    positions.set([-maxRadius, 0, 0, maxRadius, 0, 0, 0, -maxRadius, 0, 0, maxRadius, 0], offset);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
    });
    const guide = new THREE.LineSegments(geometry, material);
    guide.position.set(0, 0, GRID_GROUND_Z);
    guide.userData = {
        type: "concentric-circles",
        radiusStep,
        circleCount,
        maxRadius,
        segments,
        groundZ: GRID_GROUND_Z,
    };
    return guide;
}

function resizeRenderer(container, renderer, camera) {
    const width  = container.clientWidth || 1;
    const height = container.clientHeight || 480;

    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
}

function createFlyThroughWheelHandler(canvas, camera, controls) {
    const ndc       = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const forward   = new THREE.Vector3();

    return function handleFlyThroughWheel(event) {
        event.preventDefault();
        controls.autoRotate = false;

        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
        const y = -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
        ndc.set(x, y, 0.5).unproject(camera);
        direction.copy(ndc).sub(camera.position).normalize();

        const distance = camera.position.distanceTo(controls.target);
        const wheelUnits = Math.min(Math.max(Math.abs(event.deltaY) / 120, 0.25), 3);
        const step = Math.max(distance * 0.15, MIN_FLY_STEP) * wheelUnits;
        const sign = event.deltaY < 0 ? 1 : -1;

        camera.position.addScaledVector(direction, sign * step);
        camera.getWorldDirection(forward);
        controls.target.copy(camera.position).addScaledVector(
            forward,
            Math.max(distance - sign * step, MIN_FLY_TARGET_DISTANCE),
        );
        controls.update();
    };
}

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function canUseFullscreen(element) {
    return Boolean(
        (document.fullscreenEnabled || document.webkitFullscreenEnabled)
        && (element.requestFullscreen || element.webkitRequestFullscreen),
    );
}

function requestElementFullscreen(element) {
    const request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request) {
        return undefined;
    }
    return request.call(element);
}

function exitDocumentFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) {
        return undefined;
    }
    return exit.call(document);
}

function createBoxLines(boxes) {
    if (!boxes || boxes.boxCount === 0) {
        return null;
    }

    const vertexCount = boxes.boxCount * BOX_EDGES.length * 2;
    const positions   = new Float32Array(vertexCount * 3);
    const colors      = new Uint8Array(vertexCount * 3);
    let writeIndex    = 0;

    for (let boxIndex = 0; boxIndex < boxes.boxCount; boxIndex += 1) {
        const classColor = BOX_CLASS_COLORS[boxes.classIds[boxIndex]];

        for (const [start, end] of BOX_EDGES) {
            for (const cornerIndex of [start, end]) {
                const sourceOffset = boxIndex * 24 + cornerIndex * 3;
                const targetOffset = writeIndex * 3;

                positions[targetOffset] = decodeBoxCorner(boxes.corners[sourceOffset]);
                positions[targetOffset + 1] = decodeBoxCorner(boxes.corners[sourceOffset + 1]);
                positions[targetOffset + 2] = decodeBoxCorner(boxes.corners[sourceOffset + 2]);
                colors[targetOffset] = classColor[0];
                colors[targetOffset + 1] = classColor[1];
                colors[targetOffset + 2] = classColor[2];
                writeIndex += 1;
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));

    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    return new THREE.LineSegments(geometry, material);
}

function updateBoxes(state, boxes) {
    for (const child of state.boxesGroup.children) {
        child.geometry.dispose();
        child.material.dispose();
    }
    state.boxesGroup.clear();

    const lines = createBoxLines(boxes);
    if (lines) {
        state.boxesGroup.add(lines);
    }
}

function updateDrawRange(state) {
    const eventCount = writeEventColors(
        state.colorBuffer,
        state.positionBuffer,
        activeDeltas(state),
        state.threshold,
        state.colorMode,
        activeColorRange(state),
        Boolean(state.currentQuantizedFrame),
    );

    if (state.eventOnly) {
        const deltas = activeDeltas(state);
        const selectedIndices = [];
        for (let index = 0; index < deltas.length; index += 1) {
            const value = state.currentQuantizedFrame ? deltas[index] * 0.005 : deltas[index];
            if (Math.abs(value) >= state.threshold) {
                selectedIndices.push(index);
            }
        }
        state.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(selectedIndices), 1));
        state.geometry.setDrawRange(0, selectedIndices.length);
    } else {
        state.geometry.setIndex(null);
        state.geometry.setDrawRange(0, state.currentPointCount);
    }
    state.geometry.attributes.color.needsUpdate = true;
    state.container.dataset.drawRangeCount = String(state.eventOnly ? eventCount : state.currentPointCount);
    state.container.dataset.pointCount = String(state.currentPointCount);
    state.container.dataset.eventPointCount = String(eventCount);
    return eventCount;
}

function currentSceneLoadRecord(state) {
    if (!state.sceneLoads || !state.currentScene) {
        return null;
    }
    return state.sceneLoads.get(state.currentScene.index) || null;
}

function loadedScenePercent(record) {
    if (!record) {
        return 0;
    }
    if (record.complete) {
        return 100;
    }
    if (!record.manifest) {
        return 0;
    }
    return Math.min(
        100,
        Math.max(0, Math.round((Math.max(record.frames.length, 0) / Math.max(record.manifest.frameCount, 1)) * 100)),
    );
}

function updateFrameUi(state) {
    if (state.frameSlider) {
        state.frameSlider.value = String(state.currentFrameIndex);
    }
    if (state.frameLabel) {
        const record           = currentSceneLoadRecord(state);
        const loadedFrameCount = record?.frames.length || state.sceneFrames?.length || (state.currentQuantizedFrame ? 1 : 0);
        const totalFrameCount  = record?.manifest?.frameCount || state.currentFrameCount || loadedFrameCount || 1;
        const allChunksLoaded  = record ? record.complete : state.allChunksLoaded;
        const visibleFrameMax  = allChunksLoaded
            ? Math.max(totalFrameCount - 1, 0)
            : Math.max(loadedFrameCount - 1, 0);
        state.frameLabel.textContent = `Frame ${String(state.currentFrameIndex).padStart(3, "0")} / ${String(visibleFrameMax).padStart(3, "0")}`;
    }
    updateFetchOverlay(state);
}

function applyQuantizedFrame(state, frame, frameIndex) {
    if (state.positionBuffer.length < frame.pointCount * 3) {
        state.positionBuffer = new Float32Array(frame.pointCount * 3);
        state.colorBuffer = new Uint8Array(frame.pointCount * 3);
        state.geometry.setAttribute("position", new THREE.BufferAttribute(state.positionBuffer, 3).setUsage(THREE.DynamicDrawUsage));
        state.geometry.setAttribute("color", new THREE.BufferAttribute(state.colorBuffer, 3, true).setUsage(THREE.DynamicDrawUsage));
    }

    for (let i = 0; i < frame.xyz.length; i += 1) {
        state.positionBuffer[i] = frame.xyz[i] * 0.01;
    }
    state.geometry.attributes.position.needsUpdate = true;
    state.currentFrameIndex = frameIndex;
    state.currentPointCount = frame.pointCount;
    state.currentQuantizedFrame = frame;
    updateBoxes(state, frame.boxes);
    updateDrawRange(state);
    updateFrameUi(state);
}

function applySceneFrame(state, frameIndex) {
    if (!state.sceneFrames || !state.sceneFrames[frameIndex]) {
        return;
    }

    applyQuantizedFrame(state, state.sceneFrames[frameIndex], frameIndex);
}

function setProgressText(state, text) {
    if (!state.progress) {
        return;
    }

    state.progress.textContent = text;
}

function updateFetchOverlay(state) {
    if (!state.fetchOverlay || !state.fetchFill || !state.fetchPct) {
        return;
    }

    const record  = currentSceneLoadRecord(state);
    const visible = Boolean(record && !record.complete && !record.failed);
    state.fetchOverlay.hidden = !visible;
    if (!visible) {
        return;
    }

    const percent = loadedScenePercent(record);
    state.fetchFill.style.width = `${percent}%`;
    state.fetchPct.textContent = `${percent}%`;
}

function setPlayButtonState(state, playing) {
    if (!state.playButton) {
        return;
    }

    state.playButton.innerHTML = playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    state.playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function createFetchOverlay(container) {
    const overlay = document.createElement("div");
    overlay.className = "viewer-fetch-overlay";
    overlay.id = "viewer-fetch-overlay";
    overlay.hidden = true;

    const label = document.createElement("span");
    label.className = "viewer-fetch-label";
    label.textContent = "Fetching scene...";

    const bar = document.createElement("div");
    bar.className = "viewer-fetch-bar";

    const fill = document.createElement("div");
    fill.className = "viewer-fetch-fill";
    fill.id = "viewer-fetch-fill";

    const pct = document.createElement("span");
    pct.className = "viewer-fetch-pct";
    pct.id = "viewer-fetch-pct";
    pct.textContent = "0%";

    bar.appendChild(fill);
    bar.appendChild(pct);
    overlay.appendChild(label);
    overlay.appendChild(bar);
    container.appendChild(overlay);
    return { overlay, fill, pct };
}

function createSceneLoadRecord(scene) {
    return {
        index: scene.index,
        scene,
        manifest: null,
        frames: [],
        nextChunk: 0,
        chunkCount: 0,
        complete: false,
        inFlight: false,
        failed: false,
        errorMessage: "",
        lastTouched: 0,
    };
}

function touchSceneLoadRecord(state, record) {
    state.sceneLoadClock = (state.sceneLoadClock || 0) + 1;
    record.lastTouched = state.sceneLoadClock;
}

function trimSceneLoadRecords(state) {
    if (!state.sceneLoads) {
        return;
    }

    while (state.sceneLoads.size > SCENE_LOAD_LIMIT) {
        const currentIndex = state.currentScene?.index ?? null;
        const candidates = Array.from(state.sceneLoads.values())
            .filter((record) => record.index !== currentIndex && record.complete && !record.inFlight)
            .sort((left, right) => left.lastTouched - right.lastTouched);
        if (candidates.length === 0) {
            return;
        }
        state.sceneLoads.delete(candidates[0].index);
    }
}

function setFrameStepButtonsDisabled(state, disabled) {
    if (state.prevFrameButton) {
        state.prevFrameButton.disabled = disabled;
    }
    if (state.nextFrameButton) {
        state.nextFrameButton.disabled = disabled;
    }
}

function getSceneLoadRecord(state, scene) {
    if (!scene) {
        return null;
    }

    let record = state.sceneLoads.get(scene.index);
    if (!record) {
        record = createSceneLoadRecord(scene);
        state.sceneLoads.set(scene.index, record);
        trimSceneLoadRecords(state);
    }
    return record;
}

function syncSceneLoadFlags(state, record) {
    state.allChunksLoaded = Boolean(record?.complete);
    state.loadingScene = Boolean(record && !record.complete && !record.failed);
}

function stopPlayback(state) {
    state.playing = false;
    state.playRequested = false;
    state.playbackAccumulator = 0;
    if (state.playButton) {
        state.playButton.disabled = false;
    }
    setPlayButtonState(state, false);
}

function updateFrameSliderRange(state) {
    if (!state.frameSlider) {
        return;
    }

    const loadedFrameCount = state.sceneFrames?.length || 0;
    state.frameSlider.max = String(Math.max(loadedFrameCount - 1, 0));
    state.frameSlider.disabled = loadedFrameCount <= 1;
    setFrameStepButtonsDisabled(state, loadedFrameCount <= 1);
}

function syncCurrentSceneFromRecord(state, record, preferredFrameIndex = 0) {
    if (!record || state.currentScene?.index !== record.index) {
        return;
    }

    if (record.manifest) {
        state.currentManifest = record.manifest;
        state.currentFrameCount = record.manifest.frameCount;
        state.valueRange = [...record.manifest.valueRange];
        state.fps = record.manifest.fps || 10;
        setupColorbar(state);
    }
    syncSceneLoadFlags(state, record);

    if (record.frames.length === 0) {
        state.sceneFrames = null;
        state.currentQuantizedFrame = null;
        state.currentFrameIndex = 0;
        state.currentPointCount = 0;
        state.geometry.setDrawRange(0, 0);
        state.container.dataset.drawRangeCount = "0";
        state.container.dataset.pointCount = "0";
        updateBoxes(state, null);
        if (state.frameSlider) {
            state.frameSlider.value = "0";
            state.frameSlider.max = "0";
            state.frameSlider.disabled = true;
        }
        setFrameStepButtonsDisabled(state, true);
        updateFrameUi(state);
        return;
    }

    state.sceneFrames = record.frames;
    const frameIndex = Math.max(0, Math.min(preferredFrameIndex, record.frames.length - 1));
    updateFrameSliderRange(state);
    applySceneFrame(state, frameIndex);
    if (state.playButton) {
        state.playButton.disabled = false;
    }
}

function pumpSceneLoads(state) {
    if (!state.sceneLoads) {
        return;
    }

    const currentRecord = currentSceneLoadRecord(state);
    if (currentRecord && !currentRecord.complete && !currentRecord.failed) {
        if (!currentRecord.inFlight) {
            void startNextSceneChunk(state, currentRecord);
        }
        return;
    }
}

async function startNextSceneChunk(state, record) {
    if (!record || record.complete || record.failed || record.inFlight) {
        return;
    }

    record.inFlight = true;
    if (state.currentScene?.index === record.index) {
        syncSceneLoadFlags(state, record);
        updateFrameUi(state);
    }

    try {
        if (!record.manifest) {
            record.manifest = await loadSceneManifest(record.scene);
            record.chunkCount = record.manifest.chunkCount;
        }
        if (record.nextChunk >= record.chunkCount) {
            record.complete = true;
            return;
        }

        const chunkIndex = record.nextChunk;
        const loadedFrames = await loadSceneChunk(record.scene, chunkIndex, undefined, state.chunkMetrics);
        if (chunkIndex === 0 && loadedFrames.length === 0) {
            throw new Error(`Scene has an empty first chunk: ${record.scene.dir}`);
        }

        record.frames.push(...loadedFrames);
        record.nextChunk = chunkIndex + 1;
        record.complete = record.nextChunk >= record.chunkCount;
        record.failed = false;
        record.errorMessage = "";
        trimSceneLoadRecords(state);
    } catch (error) {
        record.failed = true;
        record.errorMessage = error instanceof Error ? error.message : String(error);
        console.warn("Failed to load scene chunk.", error);
        if (state.currentScene?.index === record.index) {
            setProgressText(state, "Failed to load scene.");
            state.playRequested = false;
            state.playing = false;
            setPlayButtonState(state, false);
            if (state.playButton) {
                state.playButton.disabled = record.frames.length === 0;
            }
        }
    } finally {
        record.inFlight = false;
        if (state.currentScene?.index === record.index) {
            const preferredFrameIndex = record.frames.length > state.currentFrameIndex
                ? state.currentFrameIndex
                : 0;
            if (!record.failed) {
                setProgressText(state, "");
            }
            syncCurrentSceneFromRecord(state, record, preferredFrameIndex);
            if (state.playRequested && record.frames.length > 0) {
                state.playing = true;
                setPlayButtonState(state, true);
                state.playbackAccumulator = 0;
                state.lastPlaybackTimestamp = performance.now();
            }
        }
        pumpSceneLoads(state);
    }
}

async function loadFullScene(state) {
    const record = currentSceneLoadRecord(state);
    if (!record) {
        return;
    }

    record.failed = false;
    record.errorMessage = "";
    setProgressText(state, "");
    pumpSceneLoads(state);
}

function populateSceneSelect(state) {
    if (!state.sceneSelect) {
        return;
    }

    state.sceneSelect.textContent = "";
    if (state.scenes.length === 0) {
        state.sceneSelect.disabled = true;
        return;
    }

    for (const scene of state.scenes) {
        const option = document.createElement("option");
        option.value = String(scene.index);
        option.textContent = scene.label;
        state.sceneSelect.appendChild(option);
    }
    state.sceneSelect.value = String(state.currentScene.index);
    state.sceneSelect.disabled = false;
}

function findSceneByIndex(scenes, sceneIndex) {
    return scenes.find((scene) => scene.index === sceneIndex) || null;
}

async function switchScene(state, scene) {
    if (!scene) {
        return;
    }

    const record = getSceneLoadRecord(state, scene);
    touchSceneLoadRecord(state, record);
    if (state.currentScene?.index === scene.index) {
        record.failed = false;
        record.errorMessage = "";
        syncCurrentSceneFromRecord(state, record, state.currentFrameIndex);
        pumpSceneLoads(state);
        return;
    }

    stopPlayback(state);
    state.currentScene = scene;
    state.currentManifest = record.manifest;
    state.currentFrameCount = record.manifest?.frameCount || 1;
    state.allChunksLoaded = record.complete;
    state.loadingScene = !record.complete && !record.failed;
    record.failed = false;
    record.errorMessage = "";
    setProgressText(state, "");
    setPlayButtonState(state, false);
    if (state.playButton) {
        state.playButton.disabled = record.frames.length === 0;
    }

    syncCurrentSceneFromRecord(state, record, 0);
    pumpSceneLoads(state);
}

function updatePlayback(state, timestamp) {
    if (!state.playing || !state.sceneFrames || state.sceneFrames.length === 0) {
        state.lastPlaybackTimestamp = timestamp;
        return;
    }

    const elapsed = Math.min((timestamp - state.lastPlaybackTimestamp) / 1000, 0.25);
    state.lastPlaybackTimestamp = timestamp;
    state.playbackAccumulator += elapsed;

    const frameDuration = 1 / state.fps;
    while (state.playbackAccumulator >= frameDuration) {
        const nextFrame = (state.currentFrameIndex + 1) % state.sceneFrames.length;
        applySceneFrame(state, nextFrame);
        state.playbackAccumulator -= frameDuration;
    }
}

function togglePlayback(state) {
    const playing = togglePlaybackState(state);
    if (playing === null) {
        return;
    }

    setPlayButtonState(state, playing);
    if (playing && !state.allChunksLoaded) {
        void loadFullScene(state);
    }
}

function stepFrame(state, delta) {
    if (!state.sceneFrames || state.sceneFrames.length === 0) {
        return;
    }

    state.playing = false;
    state.playRequested = false;
    state.playbackAccumulator = 0;
    setPlayButtonState(state, false);

    const maxIndex = state.sceneFrames.length - 1;
    const next = Math.min(Math.max(state.currentFrameIndex + delta, 0), maxIndex);
    applySceneFrame(state, next);
}

function setupViewerControls(state) {
    state.sceneSelect = document.getElementById("viewer-scene");
    state.eventModelSelect = document.getElementById("viewer-event-model");
    state.colorModeSelect = document.getElementById("viewer-color-mode");
    state.thresholdInput = document.getElementById("viewer-threshold");
    state.thresholdNumberInput = document.getElementById("viewer-threshold-number");
    state.eventOnlyCheckbox = document.getElementById("viewer-event-only-checkbox");
    state.bboxCheckbox = document.getElementById("viewer-bbox-checkbox");
    state.playButton = document.getElementById("viewer-play");
    state.prevFrameButton = document.getElementById("viewer-prev-frame");
    state.nextFrameButton = document.getElementById("viewer-next-frame");
    state.frameSlider = document.getElementById("viewer-frame");
    state.frameLabel = document.getElementById("viewer-frame-label");
    state.progress = document.getElementById("viewer-load-progress");
    state.fullscreenButton = document.getElementById("viewer-fullscreen");
    state.viewerShell = document.getElementById("viewer-shell");
    const fetchOverlay = createFetchOverlay(state.container);
    state.fetchOverlay = fetchOverlay.overlay;
    state.fetchFill = fetchOverlay.fill;
    state.fetchPct = fetchOverlay.pct;

    populateSceneSelect(state);
    if (state.sceneSelect) {
        state.sceneSelect.addEventListener("change", function () {
            const scene = findSceneByIndex(state.scenes, Number(state.sceneSelect.value));
            void switchScene(state, scene);
        });
    }

    const configureThreshold = function (slider, numberInput) {
        if (!slider || !numberInput) {
            return;
        }

        const min = Number(slider.min);
        const max = Number(slider.max);
        const step = Number(slider.step);
        const normalize = function (value) {
            const clamped = Math.min(Math.max(value, min), max);
            const stepped = min + Math.round((clamped - min) / step) * step;
            return Number(Math.min(Math.max(stepped, min), max).toFixed(3));
        };
        const setThreshold = function (value, formatNumberInput, redraw) {
            if (!Number.isFinite(value)) {
                return false;
            }
            state.threshold = normalize(value);
            slider.value = String(state.threshold);
            if (formatNumberInput) {
                numberInput.value = state.threshold.toFixed(3);
            }
            if (redraw) {
                updateDrawRange(state);
            }
            return true;
        };

        setThreshold(slider.valueAsNumber, true, false);
        slider.addEventListener("input", function () {
            setThreshold(slider.valueAsNumber, true, true);
        });
        numberInput.addEventListener("input", function () {
            const value = numberInput.valueAsNumber;
            if (Number.isFinite(value) && value >= min && value <= max) {
                setThreshold(value, false, true);
            }
        });
        numberInput.addEventListener("change", function () {
            if (!setThreshold(numberInput.valueAsNumber, true, true)) {
                numberInput.value = state.threshold.toFixed(3);
            }
        });
    };
    configureThreshold(state.thresholdInput, state.thresholdNumberInput);

    if (state.eventOnlyCheckbox) {
        state.eventOnly = state.eventOnlyCheckbox.checked;
        state.eventOnlyCheckbox.addEventListener("change", function () {
            state.eventOnly = state.eventOnlyCheckbox.checked;
            updateDrawRange(state);
        });
    }

    if (state.eventModelSelect) {
        state.eventModel = state.eventModelSelect.value;
        state.eventModelSelect.addEventListener("change", function () {
            state.eventModel = state.eventModelSelect.value;
            updateDrawRange(state);
        });
    }

    if (state.colorModeSelect) {
        state.colorMode = state.colorModeSelect.value;
        state.colorModeSelect.addEventListener("change", function () {
            state.colorMode = state.colorModeSelect.value;
            setupColorbar(state);
            updateDrawRange(state);
        });
    }

    if (state.bboxCheckbox) {
        state.boxesGroup.visible = state.bboxCheckbox.checked;
        state.bboxCheckbox.addEventListener("change", function () {
            state.boxesGroup.visible = state.bboxCheckbox.checked;
        });
    }

    if (state.playButton) {
        if (!state.currentScene) {
            state.playButton.disabled = true;
        }
        setPlayButtonState(state, false);
        state.playButton.addEventListener("click", function () {
            togglePlayback(state);
        });
    }

    if (state.prevFrameButton) {
        state.prevFrameButton.addEventListener("click", function () {
            stepFrame(state, -1);
        });
    }

    if (state.nextFrameButton) {
        state.nextFrameButton.addEventListener("click", function () {
            stepFrame(state, 1);
        });
    }

    if (state.frameSlider) {
        state.frameSlider.addEventListener("input", function () {
            state.playing = false;
            state.playRequested = false;
            setPlayButtonState(state, false);
            applySceneFrame(state, Number(state.frameSlider.value));
        });
    }

    state.container.addEventListener("keydown", function (event) {
        if (event.code !== "Space") {
            return;
        }
        event.preventDefault();
        togglePlayback(state);
    });

    if (state.fullscreenButton && state.viewerShell) {
        if (!canUseFullscreen(state.viewerShell)) {
            state.fullscreenButton.hidden = true;
        } else {
            const updateFullscreenButton = function () {
                const fullscreen = getFullscreenElement() === state.viewerShell;
                state.fullscreenButton.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Enter fullscreen");
                state.fullscreenButton.innerHTML = fullscreen ? '<i class="fas fa-compress"></i>' : '<i class="fas fa-expand"></i>';
            };

            state.fullscreenButton.hidden = false;
            state.fullscreenButton.addEventListener("click", function () {
                const handleFailure = function () {};
                if (getFullscreenElement() === state.viewerShell) {
                    Promise.resolve(exitDocumentFullscreen()).catch(handleFailure);
                    return;
                }
                Promise.resolve(requestElementFullscreen(state.viewerShell)).catch(handleFailure);
            });
            document.addEventListener("fullscreenchange", updateFullscreenButton);
            document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
            updateFullscreenButton();
        }
    }

    updateFrameUi(state);
}

async function initViewer() {
    const container = document.getElementById("viewer-container");
    if (!container) {
        return;
    }

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
        showWebGLError(container);
        return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.classList.remove("viewer-fallback");
    container.textContent = "";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    camera.up.set(0, 0, 1);
    camera.position.set(30, -30, 25);
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.enableZoom = false;
    controls.zoomToCursor = false;
    controls.saveState();
    controls.addEventListener("start", () => {
        controls.autoRotate = false;
    });
    renderer.domElement.addEventListener("dblclick", () => {
        controls.reset();
    });
    renderer.domElement.addEventListener(
        "wheel",
        createFlyThroughWheelHandler(renderer.domElement, camera, controls),
        { passive: false },
    );

    const loaded = await loadViewerInitialData();
    const pointCloud = loaded.pointCloud;
    const displayValueRange = pointCloud.valueRange;
    const geometry   = new THREE.BufferGeometry();
    const colors     = new Uint8Array(pointCloud.values.length * 3);

    geometry.setAttribute("position", new THREE.BufferAttribute(pointCloud.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true).setUsage(THREE.DynamicDrawUsage));

    const material = new THREE.PointsMaterial({
        size: 0.15,
        vertexColors: true,
        sizeAttenuation: true,
        alphaMap: createPointAlphaMap(),
        alphaTest: 0.5,
    });
    const points = new THREE.Points(geometry, material);
    const boxesGroup = new THREE.Group();
    const grid = createConcentricCircleGuide();
    scene.add(points);
    scene.add(boxesGroup);
    scene.add(grid);

    const initialSceneLoads = new Map();
    let initialRecord = null;
    if (loaded.source === "real" && loaded.scene && loaded.manifest && loaded.initialFrame) {
        initialRecord = createSceneLoadRecord(loaded.scene);
        initialRecord.manifest = loaded.manifest;
        initialRecord.frames = loaded.initialFrames?.length ? loaded.initialFrames.slice() : [loaded.initialFrame];
        initialRecord.nextChunk = Math.min(1, loaded.manifest.chunkCount);
        initialRecord.chunkCount = loaded.manifest.chunkCount;
        initialRecord.complete = initialRecord.nextChunk >= initialRecord.chunkCount;
        initialRecord.lastTouched = 1;
        initialSceneLoads.set(loaded.scene.index, initialRecord);
    }

    const state = {
        container,
        controls,
        geometry,
        boxesGroup,
        grid,
        scenes: loaded.scenes,
        currentScene: loaded.scene,
        currentManifest: loaded.manifest,
        currentFrameCount: loaded.manifest?.frameCount || 1,
        valueRange: displayValueRange,
        positionBuffer: pointCloud.positions,
        colorBuffer: colors,
        currentValues: pointCloud.values,
        currentPointCount: pointCloud.values.length,
        currentQuantizedFrame: loaded.initialFrame,
        currentFrameIndex: 0,
        eventModel: EVENT_MODELS.line,
        colorMode: "height",
        threshold: 0.072,
        eventOnly: false,
        sceneFrames: loaded.initialFrames?.length ? loaded.initialFrames.slice() : (loaded.initialFrame ? [loaded.initialFrame] : null),
        sceneLoads: initialSceneLoads,
        sceneLoadClock: initialRecord ? 1 : 0,
        chunkMetrics: loaded.chunkMetrics || [],
        loadingScene: Boolean(initialRecord && !initialRecord.complete),
        allChunksLoaded: Boolean(initialRecord?.complete),
        playing: false,
        fps: loaded.manifest?.fps || 10,
        playbackAccumulator: 0,
        lastPlaybackTimestamp: 0,
    };

    container.dataset.viewerDataSource = loaded.source;
    setupViewerControls(state);
    setupColorbar(state);
    updateFrameSliderRange(state);
    updateFrameUi(state);
    updateBoxes(state, loaded.boxes);
    updateDrawRange(state);

    window.__eventLidarViewerDebug = {
        getDataSource: function () { return loaded.source; },
        getDrawRangeCount: function () { return Number(container.dataset.drawRangeCount || 0); },
        getEventPointCount: function () { return Number(container.dataset.eventPointCount || 0); },
        getPointCount: function () { return state.currentPointCount; },
        getEventModel: function () { return state.eventModel; },
        getColorMode: function () { return state.colorMode; },
        getThreshold: function () { return state.threshold; },
        getFrameIndex: function () { return state.currentFrameIndex; },
        isFullSceneLoaded: function () {
            const record = currentSceneLoadRecord(state);
            return record ? record.complete : state.allChunksLoaded;
        },
        isScenePlaybackReady: function () { return Boolean(state.sceneFrames); },
        isPlaying: function () { return state.playing; },
        getProgressText: function () { return state.progress?.textContent || ""; },
        getFrameLabelText: function () { return state.frameLabel?.textContent || ""; },
        getFrameSliderMax: function () { return Number(state.frameSlider?.max || 0); },
        getFrameStepButtonStates: function () {
            const prevIcon = state.prevFrameButton?.querySelector("i,svg");
            const nextIcon = state.nextFrameButton?.querySelector("i,svg");
            return {
                prevDisabled: Boolean(state.prevFrameButton?.disabled),
                nextDisabled: Boolean(state.nextFrameButton?.disabled),
                prevAriaLabel: state.prevFrameButton?.getAttribute("aria-label") || "",
                nextAriaLabel: state.nextFrameButton?.getAttribute("aria-label") || "",
                prevIconClass: prevIcon?.className?.baseVal || prevIcon?.className || "",
                nextIconClass: nextIcon?.className?.baseVal || nextIcon?.className || "",
                prevIconDataIcon: prevIcon?.getAttribute("data-icon") || "",
                nextIconDataIcon: nextIcon?.getAttribute("data-icon") || "",
            };
        },
        getSceneLoadLimit: function () { return SCENE_LOAD_LIMIT; },
        getValueRange: function () { return [...state.valueRange]; },
        getBoxesVisible: function () { return state.boxesGroup.visible; },
        getGridVisible: function () { return Boolean(state.grid?.visible); },
        getGridSummary: function () {
            return {
                visible: Boolean(state.grid?.visible),
                type: state.grid?.userData?.type ?? null,
                radiusStep: state.grid?.userData?.radiusStep ?? null,
                circleCount: state.grid?.userData?.circleCount ?? null,
                maxRadius: state.grid?.userData?.maxRadius ?? null,
                segments: state.grid?.userData?.segments ?? null,
                position: state.grid?.position.toArray() || null,
                groundZ: state.grid?.userData?.groundZ ?? null,
            };
        },
        getSceneIndex: function () { return state.currentScene?.index ?? null; },
        getSceneCacheSize: function () {
            return Array.from(state.sceneLoads.values()).filter((record) => record.complete).length;
        },
        getCachedSceneIndexes: function () {
            return Array.from(state.sceneLoads.values())
                .filter((record) => record.complete)
                .map((record) => record.index);
        },
        getSceneLoadState: function (sceneIndex) {
            const key = sceneIndex === undefined ? state.currentScene?.index : Number(sceneIndex);
            const record = state.sceneLoads.get(key);
            if (!record) {
                return null;
            }
            return {
                index: record.index,
                loadedFrames: record.frames.length,
                nextChunk: record.nextChunk,
                chunkCount: record.chunkCount,
                complete: record.complete,
                inFlight: record.inFlight,
                failed: record.failed,
                percent: loadedScenePercent(record),
            };
        },
        getSceneLoadStates: function () {
            return Array.from(state.sceneLoads.values()).map((record) => ({
                index: record.index,
                loadedFrames: record.frames.length,
                nextChunk: record.nextChunk,
                chunkCount: record.chunkCount,
                complete: record.complete,
                inFlight: record.inFlight,
                failed: record.failed,
                percent: loadedScenePercent(record),
            }));
        },
        getInFlightSceneIndices: function () {
            return Array.from(state.sceneLoads.values())
                .filter((record) => record.inFlight)
                .map((record) => record.index);
        },
        getChunkMetrics: function () { return state.chunkMetrics.slice(); },
        getFetchOverlayState: function () {
            const rect = state.fetchOverlay?.getBoundingClientRect();
            const computedDisplay = state.fetchOverlay
                ? getComputedStyle(state.fetchOverlay).display
                : "";
            return {
                exists: Boolean(state.fetchOverlay),
                hidden: Boolean(state.fetchOverlay?.hidden),
                computedDisplay,
                percentText: state.fetchPct?.textContent || "",
                fillWidth: state.fetchFill?.style.width || "",
                label: state.fetchOverlay?.querySelector(".viewer-fetch-label")?.textContent || "",
                rect: rect ? { width: rect.width, height: rect.height, top: rect.top, left: rect.left } : null,
            };
        },
        getPlayButtonState: function () {
            const icon = state.playButton?.querySelector("i, svg");
            return {
                ariaLabel: state.playButton?.getAttribute("aria-label") || "",
                iconClass: icon?.getAttribute("class") || "",
                iconDataIcon: icon?.getAttribute("data-icon") || "",
                width: state.playButton?.getBoundingClientRect().width || 0,
            };
        },
        getSceneLabels: function () { return state.scenes.map((scene) => scene.label); },
        getSceneSelectDisabled: function () { return Boolean(state.sceneSelect?.disabled); },
        isLoadingScene: function () {
            const record = currentSceneLoadRecord(state);
            return Boolean(record && !record.complete && !record.failed);
        },
        getCameraPosition: function () { return camera.position.toArray(); },
        getCameraTarget: function () { return controls.target.toArray(); },
        resetView: function () { controls.reset(); },
        togglePlayback: function () { togglePlayback(state); },
        loadFullScene: function () { void loadFullScene(state); },
        switchScene: function (sceneIndex) {
            const scene = findSceneByIndex(state.scenes, sceneIndex);
            return switchScene(state, scene);
        },
        getCanvasMetrics: function () {
            const canvasRect = renderer.domElement.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            return {
                canvasClientWidth: canvasRect.width,
                canvasClientHeight: canvasRect.height,
                containerClientWidth: containerRect.width,
                containerClientHeight: containerRect.height,
                canvasDrawingWidth: renderer.domElement.width,
                canvasDrawingHeight: renderer.domElement.height,
            };
        },
    };

    resizeRenderer(container, renderer, camera);
    const resizeObserver = new ResizeObserver(() => {
        resizeRenderer(container, renderer, camera);
    });
    resizeObserver.observe(container);

    if (state.currentScene && loaded.source === "real") {
        pumpSceneLoads(state);
    }

    renderer.setAnimationLoop((timestamp) => {
        controls.update();
        updatePlayback(state, timestamp);
        renderer.render(scene, camera);
    });
}

initViewer();
