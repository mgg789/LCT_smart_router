import { type EngineerLiveView, loadEngineerLive } from '../api/live';

/** Whether the engineer can explicitly enter the line for the first time today. */
export function shouldEnterLiveLine(view: EngineerLiveView): boolean {
  return (
    view.workday.status === 'running' &&
    view.engineer.lineStartedAt == null &&
    (view.engineer.lineStatus === 'pending' || view.engineer.lineStatus === 'no_show_offline')
  );
}

/** Reading a session never records attendance; entry requires an explicit action. */
export async function loadEngineerSessionLive(token: string): Promise<EngineerLiveView> {
  return loadEngineerLive(token);
}
