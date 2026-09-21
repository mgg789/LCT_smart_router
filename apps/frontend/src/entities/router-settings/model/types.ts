/**
 * Technical revision of the Router (`GET/PUT /dispatch/router/technical-settings`).
 *
 * The PUT replaces the whole revision, and the field list has already grown twice
 * beyond what the contract document lists. So only the fields the UI actually
 * touches are named; everything else is carried through untouched, which keeps a
 * write correct even when the server knows settings this client does not.
 */
export interface RouterSettingsView extends Record<string, unknown> {
  /** Lunches are off by default (D-26); the dashboard is what turns them on. */
  lunchesEnabled: boolean;
  /** CAS token: send it back as `expectedContextVersion` or the write is refused. */
  routerContextVersion: string;
}
