export function matchesAccountSearch(record, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  const history = Array.isArray(record.history) ? record.history.map(entry => entry.text || '').join('\n') : '';
  return [record.title, record.note, record.plan, record.stakeholders, history]
    .filter(value => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}
