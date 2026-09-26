/**
 * Copy and path for a request page that can later carry search metadata.
 *
 * The head is intentionally left alone: no `document.title`, canonical link or
 * Open Graph tags yet. The page is addressable at `path`, and the strings are
 * ready to attach when that pass starts.
 */
export interface ClientRequestSeo {
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

/** Stable public path of one customer request. */
export function clientRequestPath(id: string): string {
  return `/client/requests/${encodeURIComponent(id)}`;
}

/** Id from `/client/requests/:id`, or null on the home and list paths. */
export function clientRequestIdFromPath(pathname: string): string | null {
  const match = /^\/client\/requests\/([^/]+)\/?$/.exec(pathname);
  const raw = match?.[1];
  if (raw === undefined || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Title and description a later head-tag pass can publish unchanged. */
export function clientRequestSeo(item: {
  id: string;
  addressText: string;
  statusLabel: string;
  problemTitle: string;
}): ClientRequestSeo {
  return {
    path: clientRequestPath(item.id),
    title: `${item.statusLabel}: ${item.addressText}`,
    description: `${item.problemTitle}. ${item.addressText}.`,
  };
}
