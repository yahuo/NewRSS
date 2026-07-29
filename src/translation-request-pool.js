class TranslationRequestPool {
  constructor(concurrency = 3) {
    this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 3));
    this.providers = new Map();
  }

  run(provider, operation, { signal, group = null } = {}) {
    if (typeof operation !== 'function') {
      throw new TypeError('translation request operation must be a function');
    }
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const key = String(provider || 'default');
    const state = this.getProviderState(key);
    return new Promise((resolve, reject) => {
      const request = {
        operation,
        resolve,
        reject,
        signal,
        group: group || Symbol('translation-request'),
        abortListener: null,
      };

      if (signal) {
        request.abortListener = () => {
          const index = state.queue.indexOf(request);
          if (index === -1) {
            return;
          }
          state.queue.splice(index, 1);
          reject(abortReason(signal));
          this.deleteGroupStateIfIdle(state, request.group);
          this.deleteProviderStateIfIdle(key, state);
        };
        signal.addEventListener('abort', request.abortListener, { once: true });
      }

      state.queue.push(request);
      if (signal?.aborted) {
        request.abortListener();
        return;
      }
      this.scheduleDrain(key, state);
    });
  }

  getProviderState(provider) {
    let state = this.providers.get(provider);
    if (!state) {
      state = {
        active: 0,
        activeGroups: new Map(),
        dispatchSequence: 0,
        drainScheduled: false,
        lastDispatched: new Map(),
        queue: [],
      };
      this.providers.set(provider, state);
    }
    return state;
  }

  scheduleDrain(provider, state) {
    if (state.drainScheduled) {
      return;
    }
    state.drainScheduled = true;
    queueMicrotask(() => {
      state.drainScheduled = false;
      this.drain(provider, state);
    });
  }

  drain(provider, state) {
    while (state.active < this.concurrency && state.queue.length) {
      const request = takeNextRequest(state);
      if (request.abortListener) {
        request.signal.removeEventListener('abort', request.abortListener);
      }
      if (request.signal?.aborted) {
        request.reject(abortReason(request.signal));
        this.deleteGroupStateIfIdle(state, request.group);
        continue;
      }

      state.active += 1;
      state.dispatchSequence += 1;
      state.lastDispatched.set(request.group, state.dispatchSequence);
      state.activeGroups.set(request.group, (state.activeGroups.get(request.group) || 0) + 1);
      Promise.resolve()
        .then(request.operation)
        .then(request.resolve, request.reject)
        .finally(() => {
          state.active -= 1;
          const groupActive = (state.activeGroups.get(request.group) || 1) - 1;
          if (groupActive === 0) {
            state.activeGroups.delete(request.group);
          } else {
            state.activeGroups.set(request.group, groupActive);
          }
          this.deleteGroupStateIfIdle(state, request.group);
          this.scheduleDrain(provider, state);
          this.deleteProviderStateIfIdle(provider, state);
        });
    }
    this.deleteProviderStateIfIdle(provider, state);
  }

  deleteProviderStateIfIdle(provider, state) {
    if (!state.drainScheduled && state.active === 0 && state.queue.length === 0) {
      this.providers.delete(provider);
    }
  }

  deleteGroupStateIfIdle(state, group) {
    if (
      !state.activeGroups.has(group) &&
      !state.queue.some((request) => request.group === group)
    ) {
      state.lastDispatched.delete(group);
    }
  }
}

module.exports = TranslationRequestPool;

function abortReason(signal) {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}

function takeNextRequest(state) {
  let selectedIndex = 0;
  let selectedSequence = state.lastDispatched.get(state.queue[0].group) ?? Number.NEGATIVE_INFINITY;
  for (let index = 1; index < state.queue.length; index += 1) {
    const sequence = state.lastDispatched.get(state.queue[index].group) ?? Number.NEGATIVE_INFINITY;
    if (sequence < selectedSequence) {
      selectedIndex = index;
      selectedSequence = sequence;
    }
  }
  return state.queue.splice(selectedIndex, 1)[0];
}
