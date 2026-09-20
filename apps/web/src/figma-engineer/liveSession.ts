import { type EngineerLiveView, loadEngineerLive, sendEngineerLiveAction } from '../api/live';

/** Whether an authenticated engineer still needs the temporary automatic line entry. */
export function shouldEnterLiveLine(view: EngineerLiveView): boolean {
  return (
    view.workday.status === 'running' &&
    (view.engineer.lineStatus === 'pending' || view.engineer.lineStatus === 'no_show_offline')
  );
}

/** Loads LIVE state and treats the signed-in session as the engineer's shift entry. */
export async function loadEngineerSessionLive(token: string): Promise<EngineerLiveView> {
  const view = await loadEngineerLive(token);
  return shouldEnterLiveLine(view) ? sendEngineerLiveAction(token, { kind: 'online' }) : view;
}
