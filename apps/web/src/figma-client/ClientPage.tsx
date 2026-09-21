import { ClientApp } from './ClientApp';

/**
 * Public `/client` entry. The home is a new request; a session appears only
 * after an email code, and a request is stored only after that code.
 */
export function ClientPage() {
  return <ClientApp />;
}
