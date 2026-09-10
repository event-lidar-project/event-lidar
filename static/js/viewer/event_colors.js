import { turbo } from "./turbo.js";

export const DELTA_QUANTIZATION_M = 0.005;
export const NON_EVENT_COLOR = [10, 10, 10];

export function writeEventColors(colors, positions, deltas, threshold, colorMode, valueRange, quantized) {
    const [vmin, vmax] = valueRange;
    const span = Math.max(vmax - vmin, 1e-6);
    const scale = 1 / span;
    let eventCount = 0;

    for (let i = 0; i < deltas.length; i += 1) {
        const delta = quantized ? deltas[i] * DELTA_QUANTIZATION_M : deltas[i];
        const colorIndex = i * 3;
        if (Math.abs(delta) < threshold) {
            colors[colorIndex] = NON_EVENT_COLOR[0];
            colors[colorIndex + 1] = NON_EVENT_COLOR[1];
            colors[colorIndex + 2] = NON_EVENT_COLOR[2];
            continue;
        }

        const value = colorMode === "height" ? positions[colorIndex + 2] : delta;
        const [r, g, b] = turbo((value - vmin) * scale);
        colors[colorIndex] = Math.round(r * 255);
        colors[colorIndex + 1] = Math.round(g * 255);
        colors[colorIndex + 2] = Math.round(b * 255);
        eventCount += 1;
    }

    return eventCount;
}
