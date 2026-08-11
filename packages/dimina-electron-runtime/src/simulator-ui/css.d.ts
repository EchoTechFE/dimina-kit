/**
 * The UI components import their own stylesheet for side effects. Only a
 * bundler consumes these modules, so the declaration just has to make the
 * import resolve.
 */
declare module '*.css'
