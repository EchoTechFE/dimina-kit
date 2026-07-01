// minimal node:os shim for browser
export const cpus = () => [{}, {}, {}, {}]
export const totalmem = () => 2 * 1024 * 1024 * 1024
export const freemem = () => 1 * 1024 * 1024 * 1024
export const platform = () => 'browser'
export const tmpdir = () => '/tmp'
export const EOL = '\n'
export default { cpus, totalmem, freemem, platform, tmpdir, EOL }
