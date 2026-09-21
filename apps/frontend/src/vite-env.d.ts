/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin; empty in dev and in the Docker image (same origin). */
  readonly VITE_API_BASE?: string;
}
