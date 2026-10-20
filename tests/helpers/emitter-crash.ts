/** What `tsp compile` prints when an emitter's `$onEmit` throws (captured from compiler 1.10.0; install paths made neutral). */
export const EMITTER_CRASH_RAW = `TypeSpec compiler v1.10.0

- Compiling...
✔ Compiling
- Running boom...
× Running boom...
Emitter "boom" crashed! This is a bug.
Please contact library author to report this issue.

TypeError: Cannot read properties of null (reading 'foo')
    at Object.$onEmit [as emitFunction] (file:///private/tmp/crash/boom/index.js:3:5)
    at runEmitter (file:///Users/dev/app/node_modules/@typespec/compiler/src/core/program.ts:1007:19)
    at file:///Users/dev/app/node_modules/@typespec/compiler/src/core/program.ts:979:39
    at trackAction (file:///Users/dev/app/node_modules/@typespec/compiler/src/core/logger/console-sink.ts:188:26)
    at emit (file:///Users/dev/app/node_modules/@typespec/compiler/src/core/program.ts:977:23)
    at compile (file:///Users/dev/app/node_modules/@typespec/compiler/src/core/program.ts:195:32)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at compileOnce (file:///Users/dev/app/node_modules/@typespec/compiler/src/core/cli/actions/compile/compile.ts:71:21)

--------------------------------------------------
Library Version                0.0.1
TypeSpec Compiler Version      1.10.0
--------------------------------------------------
`;
