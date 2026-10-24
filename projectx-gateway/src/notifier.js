/**
 * Telegram alerts for actions the gateway takes on its own (flatten fallback,
 * orphan stop cancels, startup failures). Guard state changes are announced by the
 * strategy through Freqtrade's own Telegram, so they are not repeated here.
 */
export function createNotifier(telegram = {}) {
  const enabled = Boolean(telegram.enabled && telegram.token && telegram.chat_id);
  return async function notify(text) {
    if (!enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chat_id, text: `[projectx-gateway] ${text}` }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.warn(`[notify] telegram failed: ${err.message}`);
    }
  };
}
