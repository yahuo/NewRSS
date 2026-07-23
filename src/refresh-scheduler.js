function scheduleRefreshes({ feedService, parser, config, setIntervalFn = setInterval }) {
  const runRefresh = async () => {
    try {
      const result = await feedService.tryRefreshAllFeeds({ parser });
      if (result?.skipped) {
        console.log(`[refresh] skipped scheduled run: ${result.reason}`);
        return result;
      }
      console.log(`[refresh] completed for ${result.length} feeds`);
      return result;
    } catch (error) {
      console.error(`[refresh] failed: ${error.message}`);
      return null;
    }
  };

  const runCodexProbe = async () => {
    try {
      const status = feedService.getCodexStatus();
      if (status) {
        await feedService.probeCodex({ force: false });
      }
    } catch (error) {
      console.error(`[codex] automatic probe failed: ${error.message}`);
    }
  };

  if (config.refreshOnBoot) {
    void runRefresh();
  }
  void runCodexProbe();

  const timers = [];
  if (config.refreshIntervalMinutes > 0) {
    timers.push(setIntervalFn(runRefresh, config.refreshIntervalMinutes * 60 * 1000));
  }
  timers.push(setIntervalFn(runCodexProbe, 60 * 1000));

  return { runRefresh, runCodexProbe, timers };
}

module.exports = { scheduleRefreshes };
