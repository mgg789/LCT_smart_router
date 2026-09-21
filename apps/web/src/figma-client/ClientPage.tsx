import { ClientApp } from './ClientApp';

/**
 * Public `/client` entry. First pass is the Figma UI preview — no login,
 * no live client API.
 */
export function ClientPage() {
  return <ClientApp />;
}
