// minimal node:os shim for browser
export const cpus = () => [{}, {}, {}, {}]
export const totalmem = () => 2 * 1024 * 1024 * 1024
export const freemem = () => 1 * 1024 * 1024 * 1024
export const platform = () => 'browser'
export const tmpdir = () => '/tmp'
// homedir: lilconfig (via the real cssnano's config lookup) calls os.homedir()
// while walking up for a cssnano config. We have none, so any stable path works.
export const homedir = () => '/'
export const EOL = '\n'
export default { cpus, totalmem, freemem, platform, tmpdir, homedir, EOL }
