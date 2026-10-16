export function sessionTitle(thread) {
  if (thread.name?.trim()) return thread.name.trim();
  const preview = String(thread.preview || '')
    .replace(/<(environment_context|user_instructions|system_reminder|permissions instructions)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ').trim();
  if (preview) return preview.length > 100 ? preview.slice(0, 97) + '…' : preview;
  const project = String(thread.cwd || '').split(/[\\/]/).filter(Boolean).at(-1);
  return project ? `Conversation in ${project}` : 'New conversation';
}
