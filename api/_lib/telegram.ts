type GameEvent = {
  eventId: string;
  event: 'game_started' | 'game_died' | 'leaderboard_name_submitted';
  score?: number;
  displayName?: string;
  detail?: string;
};

export async function sendGameEvent(event: GameEvent): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;
  const lines = [
    '🎮 <b>submarine-dash</b> — <b>' + escapeHtml(event.event.replaceAll('_', ' ')) + '</b>',
    'Event: <code>' + escapeHtml(event.eventId) + '</code>',
    ...(event.score === undefined ? [] : ['Score: <b>' + event.score.toLocaleString('en-US') + '</b>']),
    ...(event.displayName ? ['Name: <b>' + escapeHtml(event.displayName) + '</b>'] : []),
    ...(event.detail ? ['Detail: ' + escapeHtml(event.detail)] : []),
    'At: ' + new Date().toISOString(),
  ];
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Telegram send failed with status ${response.status}`);
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
