// Minimal `less` stub for the browser build.
// The base example uses .wxss only; .less compilation is not wired yet.
// (less ships a browser build; proper interop can replace this stub later.)
const less = {
  render() {
    return Promise.reject(new Error('[less] .less compilation not supported in this browser build yet'))
  },
}
export default less
