// minimal node:process shim for browser
const proc = {
  cwd: () => '/',
  chdir: () => {},
  platform: 'browser',
  env: {},
  argv: ['node', 'compiler'],
  version: 'v18.0.0',
  versions: { node: '18.0.0' },
  nextTick: (cb, ...args) => Promise.resolve().then(() => cb(...args)),
  exit: () => {},
  on: () => {},
  hrtime: () => [0, 0],
}
export default proc
export const cwd = proc.cwd
export const env = proc.env
export const platform = proc.platform
export const argv = proc.argv
export const nextTick = proc.nextTick
