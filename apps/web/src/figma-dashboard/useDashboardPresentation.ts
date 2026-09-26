import { useMemo } from 'react';
import {
  ALL_REGIONS,
  filterSnapshotByRegion,
  type RegionSelection,
  regionOptions,
  regionStyle,
} from '../domain/regions';
import type { useDashboard } from '../hooks/useDashboard';
import { explainSelection } from '../lib/explanations';
import { filterEngineers } from './fixtures';
import { dashboardViewFromSnapshot, rightPanelMode, withLiveRouteStops } from './fromSnapshot';

type DashboardController = ReturnType<typeof useDashboard>;

/**
 * Derives every screen-facing dashboard value from a single live snapshot.
 *
 * Keeping this projection out of the artboard component makes region filtering,
 * LIVE overlays and focus selection testable as one read-only boundary. Mutations
 * and modal state deliberately remain in MainDashboardPage.
 */
export function useDashboardPresentation(
  dash: DashboardController,
  selectedRegion: RegionSelection,
  searchQuery: string,
) {
  const visibleSnapshot = useMemo(
    () => (dash.snapshot ? filterSnapshotByRegion(dash.snapshot, selectedRegion) : null),
    [dash.snapshot, selectedRegion],
  );
  const regions = useMemo(
    () => (dash.snapshot ? regionOptions(dash.snapshot) : []),
    [dash.snapshot],
  );
  const view = useMemo(
    () =>
      visibleSnapshot
        ? dashboardViewFromSnapshot(visibleSnapshot, {
            engineerId: dash.selectedEngineerId,
            requestId: dash.selectedRequest?.id ?? null,
          })
        : null,
    [dash.selectedEngineerId, dash.selectedRequest, visibleSnapshot],
  );
  const roster = useMemo(
    () =>
      visibleSnapshot
        ? withLiveRouteStops(view?.engineers ?? [], visibleSnapshot, dash.liveWorkday)
        : [],
    [dash.liveWorkday, view?.engineers, visibleSnapshot],
  );
  const liveProgress = useMemo(
    () =>
      new Map(
        dash.liveWorkday?.engineers.map((engineer) => [engineer.id, engineer.progress]) ?? [],
      ),
    [dash.liveWorkday],
  );
  const visibleEngineers = useMemo(
    () => filterEngineers(roster, searchQuery),
    [roster, searchQuery],
  );
  const liveCompleted = useMemo(
    () =>
      new Map(
        dash.liveWorkday?.engineers.map((engineer) => [
          engineer.id,
          engineer.stats.completedCount + engineer.stats.assumedCompletedCount,
        ]) ?? [],
      ),
    [dash.liveWorkday],
  );
  const engineerNames = useMemo(
    () => new Map((dash.snapshot?.engineers ?? []).map((item) => [item.id, item.displayName])),
    [dash.snapshot],
  );
  const selectedEngineer = dash.selectedEngineerId
    ? (visibleEngineers.find((item) => item.id === dash.selectedEngineerId) ?? null)
    : null;
  const panelMode = rightPanelMode(dash.selectedEngineerId, dash.selectedRequest?.id ?? null);
  const panelExplanation = useMemo(() => {
    if (!dash.snapshot) return null;
    if (panelMode === 'request' && dash.selectedRequest) {
      return explainSelection(
        dash.snapshot,
        dash.selectedRequest,
        dash.selectedAssignment,
        dash.selectedEngineer,
        dash.selectedRoute,
      );
    }
    if (panelMode === 'plan' && dash.selectedEngineer) {
      return explainSelection(dash.snapshot, null, null, dash.selectedEngineer, dash.selectedRoute);
    }
    return null;
  }, [
    dash.selectedAssignment,
    dash.selectedEngineer,
    dash.selectedRequest,
    dash.selectedRoute,
    dash.snapshot,
    panelMode,
  ]);

  return {
    visibleSnapshot,
    regions,
    view,
    roster,
    liveProgress,
    visibleEngineers,
    liveCompleted,
    engineerNames,
    selectedEngineer,
    panelMode,
    showRightPanel: panelMode !== null,
    showRouteCard: selectedEngineer !== null,
    regionLabel: selectedRegion === ALL_REGIONS ? 'Все регионы' : regionStyle(selectedRegion).label,
    panelExplanation,
  };
}
