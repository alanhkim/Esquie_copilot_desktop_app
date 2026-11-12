const statuses = new Set(['next', 'doing', 'waiting', 'done']);

export function matchingTasks(tasks, conversations, query, showDone) {
  const needle = query.trim().toLocaleLowerCase();
  const notes = new Map();
  for (const message of conversations) {
    if (typeof message.text !== 'string') continue;
    const texts = notes.get(message.taskId) || [];
    texts.push(message.text);
    notes.set(message.taskId, texts);
  }
  return tasks.filter(task => {
    if (!showDone && task.status === 'done') return false;
    const text = [
      task.title, task.details, ...(notes.get(task.id) || []),
      ...(task.evidence || []).flatMap(item => [item.title, item.note, item.url])
    ].filter(value => typeof value === 'string').join('\n');
    return text.toLocaleLowerCase().includes(needle);
  });
}

export function laneMove(task, status, { drag = false } = {}) {
  if (!statuses.has(status)) throw new Error('Choose a supported task lane.');
  if (task.status === status) return null;
  // Dragging never completes or reopens work; those transitions need a named control.
  if (drag && (task.status === 'done' || status === 'done')) return null;
  return { status, revision: task.revision || 0 };
}
