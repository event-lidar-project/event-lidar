export function togglePlaybackState(state) {
    if (!state.currentScene || !state.sceneFrames || state.sceneFrames.length === 0) {
        return null;
    }

    state.controls.autoRotate = false;
    state.playing = !state.playing;
    state.playRequested = state.playing;
    state.playbackAccumulator = 0;
    return state.playing;
}
