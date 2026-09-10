export const EVENT_MODELS = Object.freeze({
    line: "line",
    plane: "plane",
});

export function selectEventDeltas(eventModel, quantizedFrame, fallbackValues) {
    if (!quantizedFrame) {
        return fallbackValues;
    }
    return eventModel === EVENT_MODELS.plane ? quantizedFrame.planeDeltas : quantizedFrame.deltas;
}
