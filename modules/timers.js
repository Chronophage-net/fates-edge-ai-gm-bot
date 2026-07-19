function addTimer(state, name, maxSegments, onFill = 'Event triggers.') {
  if (!state.scene) state.scene = { timers: [] };
  const existing = state.scene.timers.find(t => t.name === name);
  if (existing) {
    existing.current = 0;
    existing.max = maxSegments;
    existing.onFill = onFill;
  } else {
    state.scene.timers.push({
      name,
      current: 0,
      max: maxSegments,
      onFill
    });
  }
}

function tickTimer(state, name, ticks = 1) {
  const timer = state.scene.timers.find(t => t.name === name);
  if (!timer) return false;
  timer.current = Math.min(timer.max, timer.current + ticks);
  if (timer.current >= timer.max) {
    // Timer filled – trigger event and remove it
    return true;
  }
  return false;
}

function resolveTimer(state, name) {
  const idx = state.scene.timers.findIndex(t => t.name === name);
  if (idx === -1) return null;
  const timer = state.scene.timers[idx];
  const event = timer.onFill || 'Timer fills.';
  state.scene.timers.splice(idx, 1);
  return event;
}

function getTimerStatus(state) {
  if (!state.scene || !state.scene.timers.length) return 'No active timers.';
  return state.scene.timers
    .map(t => `- ${t.name}: ${t.current}/${t.max}`)
    .join('\n');
}

// Three-timer rule: maintain at most three active timers in a scene.
// This function enforces it by merging or retiring redundant timers.
function enforceThreeTimers(state) {
  if (!state.scene) return;
  const timers = state.scene.timers;
  if (timers.length <= 3) return;
  // Simple policy: merge timers with same name, or retire the oldest ones.
  // For simplicity, we'll keep the three with the highest max (most important).
  timers.sort((a, b) => b.max - a.max);
  timers.splice(3); // keep only first three
  // Optionally, you could merge timers with same onFill or similar logic.
}

module.exports = { addTimer, tickTimer, resolveTimer, getTimerStatus, enforceThreeTimers };
