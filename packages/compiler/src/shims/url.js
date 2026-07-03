// minimal node:url shim
export const fileURLToPath = (u) => String(u).replace(/^file:\/\//, '')
export const pathToFileURL = (p) => ({ href: `file://${p}`, toString: () => `file://${p}` })
export default { fileURLToPath, pathToFileURL }
