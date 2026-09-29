const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function download(
  token: string,
  path: string,
  filename: string,
  accept: string,
): Promise<void> {
  const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Download the currently applied revision from the authenticated dispatcher API. */
export function downloadCurrentPlan(token: string): Promise<void> {
  return download(token, '/api/v1/dispatch/plan/export.xlsx', 'navix-plan.xlsx', XLSX_MIME);
}

/** Download a CSV whose headers are accepted by the tabular import flow. */
export function downloadRequestTemplate(token: string): Promise<void> {
  return download(
    token,
    '/api/v1/dispatch/data/requests/template.csv',
    'navix-requests-template.csv',
    'text/csv',
  );
}
