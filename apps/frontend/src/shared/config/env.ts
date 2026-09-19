/**
 * Runtime configuration of the frontend.
 *
 * `VITE_API_BASE` stays empty in local dev and in the Docker image: Vite proxies
 * `/api` to the System Layer and nginx serves the API from the same origin
 * (docs/frontend-api.md §1). Set it only when the API lives on another host.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/** Every API route except `/health` lives under this prefix. */
export const API_PREFIX = '/api/v1';
