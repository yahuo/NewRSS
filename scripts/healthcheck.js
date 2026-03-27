const port = Number.parseInt(process.env.PORT || '8787', 10) || 8787;
const host = process.env.HEALTHCHECK_HOST || '127.0.0.1';
const timeoutMs = Number.parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || '4000', 10) || 4000;

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: controller.signal,
    });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();
