const POINT_COUNT       = 44000;
const POSITION_STRIDE   = 3;
const VALUE_RANGE       = [-0.2, 0.2];
const DUMMY_SCENE_SEED  = 12345;

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randNormal(rng, mu, sigma) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randUniform(rng, min, max) {
    return min + (max - min) * rng();
}

function writePoint(positions, values, index, x, y, z, value) {
    const offset = index * POSITION_STRIDE;
    positions[offset] = x;
    positions[offset + 1] = y;
    positions[offset + 2] = z;
    values[index] = value;
}

function appendGround(positions, values, startIndex, count, rng) {
    let index = startIndex;

    for (let i = 0; i < count; i += 1) {
        const radius = 40 * Math.sqrt(rng());
        const theta  = 2 * Math.PI * rng();
        const x      = radius * Math.cos(theta);
        const y      = radius * Math.sin(theta);
        const z      = randNormal(rng, 0, 0.02);
        const value  = randNormal(rng, 0, 0.01);

        writePoint(positions, values, index, x, y, z, value);
        index += 1;
    }

    return index;
}

function sampleBoxSurface(rng, center, size) {
    const [cx, cy, cz] = center;
    const [sx, sy, sz] = size;
    const hx           = sx / 2;
    const hy           = sy / 2;
    const hz           = sz / 2;
    const areaXY       = sx * sy;
    const areaXZ       = sx * sz;
    const areaYZ       = sy * sz;
    const target       = randUniform(rng, 0, 2 * (areaXY + areaXZ + areaYZ));

    if (target < areaXY) {
        return [randUniform(rng, cx - hx, cx + hx), randUniform(rng, cy - hy, cy + hy), cz + hz];
    }
    if (target < 2 * areaXY) {
        return [randUniform(rng, cx - hx, cx + hx), randUniform(rng, cy - hy, cy + hy), cz - hz];
    }
    if (target < 2 * areaXY + areaXZ) {
        return [randUniform(rng, cx - hx, cx + hx), cy + hy, randUniform(rng, cz - hz, cz + hz)];
    }
    if (target < 2 * areaXY + 2 * areaXZ) {
        return [randUniform(rng, cx - hx, cx + hx), cy - hy, randUniform(rng, cz - hz, cz + hz)];
    }
    if (target < 2 * areaXY + 2 * areaXZ + areaYZ) {
        return [cx + hx, randUniform(rng, cy - hy, cy + hy), randUniform(rng, cz - hz, cz + hz)];
    }
    return [cx - hx, randUniform(rng, cy - hy, cy + hy), randUniform(rng, cz - hz, cz + hz)];
}

function appendBoxSurface(positions, values, startIndex, count, rng, center, size, valueSampler) {
    let index = startIndex;

    for (let i = 0; i < count; i += 1) {
        const [x, y, z] = sampleBoxSurface(rng, center, size);
        writePoint(positions, values, index, x, y, z, valueSampler());
        index += 1;
    }

    return index;
}

export function createPointCloud() {
    const positions = new Float32Array(POINT_COUNT * POSITION_STRIDE);
    const values    = new Float32Array(POINT_COUNT);
    const rng       = mulberry32(DUMMY_SCENE_SEED);
    let index       = 0;

    index = appendGround(positions, values, index, 30000, rng);
    index = appendBoxSurface(positions, values, index, 4000, rng, [20, 15, 3], [10, 8, 6], () => randNormal(rng, 0, 0.01));
    index = appendBoxSurface(positions, values, index, 3000, rng, [-18, 22, 4.5], [8, 12, 9], () => randNormal(rng, 0, 0.01));
    index = appendBoxSurface(positions, values, index, 3000, rng, [-12, -25, 2.5], [14, 6, 5], () => randNormal(rng, 0, 0.01));

    index = appendBoxSurface(positions, values, index, 2000, rng, [8, -4, 0.75], [4, 2, 1.5], () => randUniform(rng, 0.3, 0.5));
    index = appendBoxSurface(positions, values, index, 2000, rng, [-6, 8, 0.75], [4, 2, 1.5], () => randUniform(rng, -0.5, -0.3));

    return {
        positions,
        values,
        valueRange: [...VALUE_RANGE],
    };
}
