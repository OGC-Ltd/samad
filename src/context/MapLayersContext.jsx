// useMapLayers — shared map actions between FleetMap and the rest of the app.
//
// Same API it had as a context; the state now lives in two places:
//
//   store/mapSlice (Redux) — plain UI state:
//     activeFilter (published by FleetMap, see mapSlice) and the open flags of
//     the windows that sit ON the map but are opened from the sidebar —
//     unitsOpen, strandedOpen, fuelAlertsOpen. Only the flag crosses; each
//     window and its data stay FleetMap's.
//
//   lib/mapBridge — what is not a plain value:
//     layers / publishLayers   FleetMap's layer rows → the sidebar's tree
//     stranded / publishStranded  units stranded outside a zone — only the map
//                              has the zone geometry to work that out
//     registerFocus / focusVehicle       → AppHeader search, the live feed
//     registerFilter / applyFilter       → SidePanel cards, mobile rail. It is
//                              handleFilter, NOT a bare setter: it also moves
//                              the camera, without which picking CRITICAL reads
//                              as "the map just emptied".
//     registerPlayback / startPlayback   → the vehicle panel's Playback button
//     registerFocusBridge / focusBridge  → the sidebar's Weighbridges rows
//     registerReveal / revealMap         → put the map ON SCREEN
//
// revealMap switches the tabs HERE as well as calling FleetMap's handler: a
// reader who left the app on Drivers has never mounted the map this session,
// so nothing is registered yet — switching the tab is what mounts it. Both
// halves are idempotent.

import { useMemo } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";
import { filterPublished, windowSet } from "../store/mapSlice";
import { fieldSet, mobileTabChosen } from "../store/appSlice";
import {
  useMapPublished, publishLayers, publishStranded, registerMapCommand, runMapCommand,
} from "../lib/mapBridge";

const command = (name) => (...args) => runMapCommand(name, ...args);
const register = (name) => (fn) => registerMapCommand(name, fn);

// Stable for the life of the app: they close over nothing but the bridge.
const COMMANDS = {
  publishLayers,
  publishStranded,
  registerFocus: register("focus"),
  focusVehicle: command("focus"),
  registerFilter: register("filter"),
  applyFilter: command("filter"),
  registerPlayback: register("playback"),
  startPlayback: command("playback"),
  registerFocusBridge: register("bridge"),
  focusBridge: command("bridge"),
  registerReveal: register("reveal"),
};

export function useMapLayers() {
  const dispatch = useDispatch();
  const store = useStore();
  const map = useSelector((st) => st.map);
  const { layers, stranded } = useMapPublished();

  const actions = useMemo(() => {
    // Value or updater, applied to the current flag — as useState's were.
    const setWindow = (name) => (v) => dispatch(windowSet(name,
      typeof v === "function" ? v(store.getState().map[name]) : v));
    return {
      publishFilter: (f) => dispatch(filterPublished(f)),
      setUnitsOpen: setWindow("unitsOpen"),
      setStrandedOpen: setWindow("strandedOpen"),
      setFuelAlertsOpen: setWindow("fuelAlertsOpen"),
      revealMap: () => {
        dispatch(fieldSet("desktopActiveTab", "fleet"));
        dispatch(mobileTabChosen("map"));
        runMapCommand("reveal");
      },
    };
  }, [dispatch, store]);

  return useMemo(() => ({
    ...COMMANDS,
    ...actions,
    ...map,
    layers,
    stranded,
  }), [actions, map, layers, stranded]);
}
