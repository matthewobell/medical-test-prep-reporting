export function dateRange(days, now = new Date()) {
  if (![1, 7, 30].includes(days)) throw new Error('Choose a supported date range.');
  const end = now.toISOString().slice(0, 10);
  const start = new Date(end + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start_date: start.toISOString().slice(0, 10), end_date: end };
}

export function validateReport(data, request) {
  if (!data || data.environment !== 'test' || data.timezone !== 'UTC' ||
      data.start_date !== request.start_date || data.end_date !== request.end_date ||
      data.platform !== request.platform || !Array.isArray(data.rows) ||
      data.rows.length > 200 || typeof data.fetched_at !== 'string' ||
      Number.isNaN(Date.parse(data.fetched_at))) throw new Error('Unreadable report.');
  const seen = new Set();
  const rows = data.rows.map(row => {
    for (const key of ['campaign_id', 'creative_id', 'campaign_name', 'creative_name']) {
      if (typeof row[key] !== 'string' || !row[key].trim()) throw new Error('Unreadable report.');
    }
    if (!['ios', 'android'].includes(row.platform) ||
        (request.platform !== 'all' && row.platform !== request.platform)) throw new Error('Unreadable report.');
    const key = JSON.stringify([row.campaign_id, row.creative_id, row.platform]);
    if (seen.has(key)) throw new Error('Repeated summary in report.');
    seen.add(key);
    for (const key of ['displays', 'clicks', 'continues']) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error('Unreadable report.');
    }
    return { campaign_id: row.campaign_id, creative_id: row.creative_id,
      campaign_name: row.campaign_name, creative_name: row.creative_name,
      platform: row.platform, displays: row.displays, clicks: row.clicks, continues: row.continues };
  });
  return { ...data, rows };
}

export function total(rows) {
  const result = rows.reduce((sum, row) => ({ displays: sum.displays + row.displays,
    clicks: sum.clicks + row.clicks, continues: sum.continues + row.continues }),
    { displays: 0, clicks: 0, continues: 0 });
  if (!Object.values(result).every(Number.isSafeInteger)) throw new Error('Report is too large.');
  return result;
}

export function clickRate(summary) {
  return summary.displays ? (100 * summary.clicks / summary.displays).toFixed(1) + '%' : '—';
}
