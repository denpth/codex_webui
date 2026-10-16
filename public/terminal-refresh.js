// Recognize the native ownership-conflict screen for the manual refresh control.
export function isRetryScreen(screen) {
  const lines = screen.split('\n').map(line => line.trim()).filter(Boolean);
  const footer = lines.slice(-3).join(' ');
  return /\br\s+retry\b/i.test(footer) && /\bf\s+fork\b/i.test(footer)
    && /\bexit\b/i.test(footer) && /ctrl\+t\s+transcript\s*$/i.test(footer)
    && /This conversation is open in another app/i.test(lines.slice(-10).join(' '));
}
