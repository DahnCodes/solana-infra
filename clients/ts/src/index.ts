// @breakglass/client: everything a frontend needs to talk to Breakglass
// without reading Rust. See docs/FRONTEND.md.
//
// The IDL and its TS type are generated files in ../idl (scripts/sync-client.sh):
//   import idl from "@breakglass/client/idl/breakglass.json";
//   import type { Breakglass } from "@breakglass/client/idl/breakglass";
//   const program = new Program<Breakglass>(idl as Breakglass, provider);

export * from "./constants";
export * from "./pdas";
export * from "./errors";
export * from "./events";
export * from "./pauses";
