export interface Disposable {
  dispose(): void | Promise<void>
}

export type DisposeFn = () => void | Promise<void>

export function toDisposable(fn: DisposeFn): Disposable {
  let done = false
  return {
    dispose() {
      if (done) return
      done = true
      return fn()
    },
  }
}

interface Entry {
  fn: DisposeFn
  released: boolean
}

export class DisposableRegistry implements Disposable {
  private entries: Entry[] = []
  private _disposed = false

  add(d: Disposable | DisposeFn): Disposable {
    if (this._disposed) {
      throw new Error('cannot add to disposed registry')
    }

    const fn: DisposeFn = typeof d === 'function' ? d : () => d.dispose()
    const entry: Entry = { fn, released: false }
    this.entries.push(entry)
    return {
      dispose: () => {
        if (entry.released) return
        entry.released = true
        const i = this.entries.indexOf(entry)
        if (i >= 0) this.entries.splice(i, 1)
        return fn()
      },
    }
  }

  async disposeAll(): Promise<void> {
    if (this._disposed) return
    this._disposed = true

    const items = this.entries.slice().reverse()
    this.entries = []

    const errors: unknown[] = []
    for (const entry of items) {
      if (entry.released) continue
      entry.released = true
      try {
        await entry.fn()
      } catch (e) {
        errors.push(e)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'DisposableRegistry encountered errors during disposeAll')
    }
  }

  dispose(): Promise<void> {
    return this.disposeAll()
  }
}
