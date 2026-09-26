// Presentation only: async work and its text states never wait for a wire.
const travelMs = 880;
const settleMs = 220;

export function createWireMotion(elements, onLightChange = () => {}) {
  const flights = new Map();
  let desired = new Set();
  let disposed = false;

  function remove(id) {
    const flight = flights.get(id);
    flight.animation.onfinish = null;
    flight.animation.cancel();
    elements.get(id).dataset.flowStage = 'idle';
    flights.delete(id);
  }

  function reconcile() {
    for (const [id, flight] of flights) {
      if (desired.has(id) || flight.settling) continue;
      flight.settling = true;
      elements.get(id).dataset.flowStage = 'settling';
      const elapsed = Number(flight.animation.currentTime) || 0;
      const cycles = Math.floor(elapsed / travelMs) + 1;
      const remaining = cycles * travelMs - elapsed;
      // Keep the current position. Let the tail reach the endpoint in <=220ms.
      flight.animation.effect.updateTiming({iterations: cycles});
      flight.animation.playbackRate = Math.max(1, remaining / settleMs);
      flight.animation.onfinish = () => {
        if (disposed || flights.get(id) !== flight) return;
        remove(id);
        reconcile();
      };
    }
    // Existing parallel work continues. Only newly arriving light waits.
    if (![...flights.values()].some(flight => flight.settling)) {
      for (const id of desired) {
        if (flights.has(id)) continue;
        const element = elements.get(id);
        element.dataset.flowStage = 'running';
        const animation = element.animate(
          [{strokeDashoffset: 5}, {strokeDashoffset: -100}],
          {duration: travelMs, iterations: Infinity, easing: 'linear'}
        );
        flights.set(id, {animation, settling: false});
      }
    }
    onLightChange([...flights.keys()]);
  }

  return {
    update(active, animate = true) {
      if (disposed) return;
      desired = new Set(active);
      if (!animate) {
        for (const id of [...flights.keys()]) remove(id);
        onLightChange([...desired]);
        return;
      }
      reconcile();
    },
    dispose() {
      disposed = true;
      for (const id of [...flights.keys()]) remove(id);
    }
  };
}
