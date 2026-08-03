export function advanceVoiceEndMonitor(previous = {}, lifecycle = {}, context = {}) {
  const elapsedMs = Number(context.elapsedMs) || 0
  const busy = Boolean(context.busy)
  const seenActive = Boolean(previous.seenActive || lifecycle.active)
  const seenVoiceSurface = Boolean(previous.seenVoiceSurface || lifecycle.voiceSurface || !lifecycle.composer)
  const eligibleForStableEnd = seenActive || seenVoiceSurface
  const inactiveTicks = !busy && eligibleForStableEnd && !lifecycle.active && lifecycle.composer
    ? (Number(previous.inactiveTicks) || 0) + 1
    : 0
  const explicitEnd = !busy && Boolean(lifecycle.ended) && elapsedMs > 3_000
  const stableEnd = !busy && inactiveTicks >= 4 && elapsedMs > 12_000
  return {
    seenActive,
    seenVoiceSurface,
    inactiveTicks,
    shouldFinalize: explicitEnd || stableEnd,
    reason: explicitEnd ? 'explicit-end-text' : (stableEnd ? 'voice-surface-closed' : '')
  }
}
