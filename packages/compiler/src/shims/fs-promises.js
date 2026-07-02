// node:fs/promises -> forwards to the injected fs's promises API.
// The compiler uses no async fs; this exists only to satisfy the alias, so the
// bundle carries no memfs (or any) fs implementation of its own.
import { promises } from './fs.js'

export default promises
export const readFile = (...a) => promises.readFile(...a)
export const writeFile = (...a) => promises.writeFile(...a)
export const mkdir = (...a) => promises.mkdir(...a)
export const rm = (...a) => promises.rm(...a)
export const rmdir = (...a) => promises.rmdir(...a)
export const readdir = (...a) => promises.readdir(...a)
export const copyFile = (...a) => promises.copyFile(...a)
export const stat = (...a) => promises.stat(...a)
export const lstat = (...a) => promises.lstat(...a)
export const unlink = (...a) => promises.unlink(...a)
export const rename = (...a) => promises.rename(...a)
export const appendFile = (...a) => promises.appendFile(...a)
export const access = (...a) => promises.access(...a)
export const realpath = (...a) => promises.realpath(...a)
