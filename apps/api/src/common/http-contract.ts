/** Shared Nest HTTP namespace; generation and runtime must use the same exclusions. */
export const HTTP_CONTRACT = {
  prefix: 'api/v1',
  exclude: ['health/live', 'health/ready', 'health/services'],
};
