/** Body caches own simulator-CDP and main-process HTTP ids, never native backend ids. */
export const VIRTUAL_REQUEST_ID_PREFIX = 'dimina:sim:'
export const NATIVE_HTTP_REQUEST_ID_PREFIX = 'dimina:http:'
export const BODY_REQUEST_ID_PREFIXES = [VIRTUAL_REQUEST_ID_PREFIX, NATIVE_HTTP_REQUEST_ID_PREFIX] as const
