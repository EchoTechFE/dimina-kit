'use strict'

/**
 * Orders every message from main to the service exactly as it arrived, even when the
 * service registers its onMessage handler late or a handler re-enters `deliver`.
 * Every message goes through one FIFO; only the drain loop dispatches, so a message
 * delivered while a drain is pending or running always lands behind what is already
 * queued. Without a handler the backlog waits; `setHandler` drains it on a microtask,
 * and with nothing queued a delivery dispatches synchronously.
 *
 * `beforeDispatch` runs right before the handler sees each message — never at enqueue
 * time — so side effects it carries (like a hostEnvUpdate patching the spawn context)
 * become visible in the same order the service observes the message stream. A throw in
 * either step is reported through `onError` and never drops the message or stops the
 * stream.
 */
function createDeliveryQueue({ beforeDispatch, onError } = {}) {
  const pending = []
  let handler = null
  let drainScheduled = false
  let draining = false

  function report(stage, error) {
    if (onError) onError(stage, error)
  }

  function dispatch(msg) {
    if (beforeDispatch) {
      try {
        beforeDispatch(msg)
      } catch (error) {
        report('beforeDispatch', error)
      }
    }
    try {
      handler(msg)
    } catch (error) {
      report('onMessage', error)
    }
  }

  function drain() {
    if (draining) return
    draining = true
    try {
      while (handler && pending.length > 0) dispatch(pending.shift())
    } finally {
      draining = false
    }
  }

  function deliver(msg) {
    pending.push(msg)
    if (handler && !drainScheduled) drain()
  }

  function setHandler(fn) {
    handler = typeof fn === 'function' ? fn : null
    // An empty backlog needs no deferred drain, so the next deliver dispatches at once.
    if (!handler || drainScheduled || pending.length === 0) return
    drainScheduled = true
    queueMicrotask(() => {
      drainScheduled = false
      drain()
    })
  }

  return { deliver, setHandler, getHandler: () => handler }
}

module.exports = { createDeliveryQueue }
