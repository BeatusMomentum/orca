/** Resolve the executable for each lifecycle leg without confusing the Bun wrapper with Node. */
export function selectOrcadLifecycleRuntime({ migrationMode, bundledBun, hostNodeRuntime }) {
  return migrationMode ? hostNodeRuntime : bundledBun
}
