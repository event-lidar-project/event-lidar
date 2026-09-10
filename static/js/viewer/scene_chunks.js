export const BOX_CLASS_COLORS = [
    [255, 0, 0],
    [255, 165, 0],
    [50, 205, 50],
    [0, 0, 255],
    [174, 198, 207],
    [0, 255, 255],
    [255, 0, 255],
    [128, 0, 128],
    [0, 255, 127],
    [128, 128, 0],
];

const POINT_POSITION_SCALE = 0.01;
const POINT_DELTA_SCALE    = 0.005;
const BOX_CORNER_SCALE     = 0.01;
const BOX_BYTES            = 49;
const DEFAULT_VALUE_RANGE   = [-0.2, 0.2];

function readInt16Array(view, offset, count) {
    const values = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
        values[i] = view.getInt16(offset + i * 2, true);
    }
    return { values, offset: offset + count * 2 };
}

function assertBoxClassId(classId) {
    if (classId < 0 || classId >= BOX_CLASS_COLORS.length) {
        throw new Error(`Box class id is out of range: ${classId}`);
    }
}

function parseBoxesPayload(view, offset, boxCount) {
    const corners  = new Int16Array(boxCount * 24);
    const classIds = new Uint8Array(boxCount);

    for (let boxIndex = 0; boxIndex < boxCount; boxIndex += 1) {
        for (let valueIndex = 0; valueIndex < 24; valueIndex += 1) {
            corners[boxIndex * 24 + valueIndex] = view.getInt16(offset, true);
            offset += 2;
        }

        const classId = view.getUint8(offset);
        assertBoxClassId(classId);
        classIds[boxIndex] = classId;
        offset += 1;
    }

    return {
        boxes: {
            corners,
            classIds,
            boxCount,
        },
        offset,
    };
}

export function parseSceneChunkBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
        throw new TypeError("Scene chunk buffer must be an ArrayBuffer.");
    }
    if (buffer.byteLength < 4) {
        throw new Error("Scene chunk buffer is too small.");
    }

    const view       = new DataView(buffer);
    const frameCount = view.getUint32(0, true);
    const headerSize = 4 + frameCount * 8;
    if (buffer.byteLength < headerSize) {
        throw new Error("Scene chunk header is incomplete.");
    }

    const counts = [];
    let offset   = 4;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const pointCount = view.getUint32(offset, true);
        const boxCount   = view.getUint32(offset + 4, true);
        counts.push({ pointCount, boxCount });
        offset += 8;
    }

    const frames = [];
    offset = headerSize;
    for (const count of counts) {
        const pointBytes = count.pointCount * 10;
        const boxBytes   = count.boxCount * BOX_BYTES;
        if (offset + pointBytes + boxBytes > buffer.byteLength) {
            throw new Error("Scene chunk frame payload is incomplete.");
        }

        const xyzResult   = readInt16Array(view, offset, count.pointCount * 3);
        const lineDeltaResult  = readInt16Array(view, xyzResult.offset, count.pointCount);
        const planeDeltaResult = readInt16Array(view, lineDeltaResult.offset, count.pointCount);
        const boxResult        = parseBoxesPayload(view, planeDeltaResult.offset, count.boxCount);

        frames.push({
            xyz: xyzResult.values,
            deltas: lineDeltaResult.values,
            planeDeltas: planeDeltaResult.values,
            boxes: boxResult.boxes,
            pointCount: count.pointCount,
        });
        offset = boxResult.offset;
    }

    if (offset !== buffer.byteLength) {
        throw new Error("Scene chunk has trailing bytes.");
    }

    return frames;
}

export function decodeQuantizedFrame(frame, valueRange = DEFAULT_VALUE_RANGE) {
    const positions = new Float32Array(frame.pointCount * 3);
    const values    = new Float32Array(frame.pointCount);

    for (let i = 0; i < frame.xyz.length; i += 1) {
        positions[i] = frame.xyz[i] * POINT_POSITION_SCALE;
    }
    for (let i = 0; i < frame.deltas.length; i += 1) {
        values[i] = frame.deltas[i] * POINT_DELTA_SCALE;
    }

    return {
        positions,
        values,
        valueRange: [...valueRange],
    };
}

export function parseScenesConfig(config) {
    if (!config || typeof config !== "object" || !Array.isArray(config.scenes)) {
        throw new Error("scenes.json must contain a scenes array.");
    }
    if (config.scenes.length === 0) {
        throw new Error("scenes.json must contain at least one scene.");
    }

    const seenIndexes = new Set();
    const seenDirs    = new Set();
    return config.scenes.map(function (scene, scenePosition) {
        if (!scene || typeof scene !== "object") {
            throw new Error(`Scene entry ${scenePosition} must be an object.`);
        }

        const { index, label, dir } = scene;
        if (!Number.isInteger(index) || index < 0) {
            throw new Error(`Scene entry ${scenePosition} has an invalid index.`);
        }
        if (typeof label !== "string" || label.trim() === "") {
            throw new Error(`Scene entry ${scenePosition} has an invalid label.`);
        }
        if (typeof dir !== "string" || !/^static\/data\/scene\d+$/.test(dir)) {
            throw new Error(`Scene entry ${scenePosition} has an invalid dir.`);
        }
        if (seenIndexes.has(index)) {
            throw new Error(`Scene index is duplicated: ${index}.`);
        }
        if (seenDirs.has(dir)) {
            throw new Error(`Scene dir is duplicated: ${dir}.`);
        }
        seenIndexes.add(index);
        seenDirs.add(dir);

        return {
            index,
            label,
            dir,
        };
    });
}

export function decodeBoxCorner(value) {
    return value * BOX_CORNER_SCALE;
}
