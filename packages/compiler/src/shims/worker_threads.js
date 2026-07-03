// node:worker_threads shim.
// isMainThread = true so the compiler files SKIP their `if (!isMainThread)` parentPort
// bootstrap blocks. We drive the exported compile functions directly instead.
export const isMainThread = true
export const parentPort = null
export const workerData = null
export class Worker {
  constructor() { throw new Error('worker_threads.Worker is not available in browser build') }
}
export default { isMainThread, parentPort, workerData, Worker }
