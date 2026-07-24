function scheduleRefreshes({
  feedService,
  readLaterService = null,
  parser,
  config,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const activeRuns = new Set();
  let stopping = false;
  let stopPromise = null;

  const track = (operation) => {
    if (stopping) {
      return Promise.resolve({ skipped: true, reason: 'scheduler is stopping' });
    }
    const run = Promise.resolve().then(operation);
    activeRuns.add(run);
    void run.finally(() => activeRuns.delete(run));
    return run;
  };

  const runRefresh = () => track(async () => {
    try {
      const result = await feedService.tryRefreshAllFeeds({ parser });
      if (result?.skipped) {
        console.log(`[refresh] skipped scheduled run: ${result.reason}`);
        return result;
      }
      await readLaterService?.retryDueTranslations?.();
      console.log(`[refresh] completed for ${result.length} feeds`);
      return result;
    } catch (error) {
      console.error(`[refresh] failed: ${error.message}`);
      return null;
    }
  });

  const runCodexProbe = () => track(async () => {
    try {
      const service = feedService.isCodexProvider()
        ? feedService
        : readLaterService?.isCodexProvider?.()
          ? readLaterService
          : null;
      if (service) {
        await service.probeCodex({ force: false });
      }
    } catch (error) {
      console.error(`[codex] automatic probe failed: ${error.message}`);
    }
  });

  if (config.refreshOnBoot) {
    void runRefresh();
  }
  void runCodexProbe();

  const timers = [];
  if (config.refreshIntervalMinutes > 0) {
    timers.push(setIntervalFn(runRefresh, config.refreshIntervalMinutes * 60 * 1000));
  }
  timers.push(setIntervalFn(runCodexProbe, 60 * 1000));

  const stop = () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopping = true;
    for (const timer of timers) {
      clearIntervalFn(timer);
    }
    stopPromise = Promise.allSettled(Array.from(activeRuns)).then(() => undefined);
    return stopPromise;
  };

  return { runRefresh, runCodexProbe, timers, stop };
}

module.exports = { scheduleRefreshes };
