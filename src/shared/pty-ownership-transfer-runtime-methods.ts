/** Additive paired-runtime RPCs; older hosts fail closed with method_not_found. */
export const PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS = Object.freeze({
  preflightSource: 'pty.ownershipTransfer.preflightSource',
  grantSource: 'pty.ownershipTransfer.grantSource',
  statusSource: 'pty.ownershipTransfer.statusSource',
  prepareSource: 'pty.ownershipTransfer.prepareSource',
  replaySource: 'pty.ownershipTransfer.replaySource',
  commitSource: 'pty.ownershipTransfer.commitSource',
  publishSource: 'pty.ownershipTransfer.publishSource',
  inputSource: 'pty.ownershipTransfer.inputSource',
  retireInputSource: 'pty.ownershipTransfer.retireInputSource',
  attachSource: 'pty.ownershipTransfer.attachSource',
  rekeyReconnectSource: 'pty.ownershipTransfer.rekeyReconnectSource',
  controlSource: 'pty.ownershipTransfer.controlSource',
  abortSource: 'pty.ownershipTransfer.abortSource',
  acknowledgeOutputSource: 'pty.ownershipTransfer.acknowledgeOutputSource',
  streamSource: 'pty.ownershipTransfer.streamSource'
})
