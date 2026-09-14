/**
 * Stub for the optional `react-devtools-core` peer that Ink's devtools module
 * imports. The CLI never enables Ink devtools (that would require a Debugger
 * listening on ws://localhost:8097), so bundling the real package would only
 * bloat the executable. Aliased in tsconfig.json.
 */
const devtools = {
  initialize(): void {
    /* no-op */
  },
  connectToDevTools(): void {
    /* no-op */
  },
};

export default devtools;
