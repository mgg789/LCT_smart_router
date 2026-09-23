import type { ApiError } from '@/shared/api';
import {
  MALFORMED_RESPONSE_CODE,
  NETWORK_ERROR_CODE,
  UPSTREAM_UNAVAILABLE_CODE,
} from '@/shared/api';

/**
 * Russian wording for the error codes this screen can actually receive.
 *
 * Only codes documented for the auth routes are translated; anything else keeps
 * the server message and the `requestId`, so an unknown failure stays traceable
 * instead of being flattened into a made-up phrase.
 */
function fallback(error: ApiError): string {
  const suffix = error.requestId ? ` (запрос ${error.requestId})` : '';
  return `${error.message}${suffix}`;
}

function transportMessage(error: ApiError): string | null {
  if (error.code === NETWORK_ERROR_CODE) {
    return 'Нет связи с сервером. Проверьте, что System Layer запущен.';
  }
  if (error.code === UPSTREAM_UNAVAILABLE_CODE) {
    return 'Сервер API не отвечает. Проверьте, что System Layer запущен.';
  }
  if (error.code === MALFORMED_RESPONSE_CODE) {
    return 'Сервер ответил неожиданным форматом. Повторите попытку.';
  }
  if (error.code === 'SERVICE_NOT_CONFIGURED') {
    return 'Вход по коду сейчас недоступен: сервис не настроен.';
  }
  return null;
}

export function requestCodeErrorMessage(error: ApiError): string {
  const transport = transportMessage(error);
  if (transport) return transport;
  if (error.code === 'VALIDATION_FAILED') return 'Проверьте адрес почты.';
  return fallback(error);
}

export function verifyCodeErrorMessage(error: ApiError): string {
  const transport = transportMessage(error);
  if (transport) return transport;
  if (error.code === 'UNAUTHENTICATED') return 'Код не подошёл или истёк. Запросите новый.';
  if (error.code === 'FORBIDDEN') return 'У этой почты нет роли диспетчера.';
  if (error.code === 'VALIDATION_FAILED') return 'Проверьте почту и код из письма.';
  return fallback(error);
}
