/**
 * Server failures on the phone are a banner inside the column.
 * Form hints stay inline; they are not this banner.
 */
export function isPhoneFailureNotice(notice: string | null | undefined): notice is string {
  if (!notice) return false;
  return /не ответил|нет связи|не удалось|истёк|истек|сессия/i.test(notice);
}
