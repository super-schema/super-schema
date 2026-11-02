// Vendored from "pglite-prisma-adapter" (github.com/lucasthevenet/pglite-utils), MIT License (see LICENSE in this directory).
// Inlined because the package is not available in this environment's npm registry.
// Upstream: packages/prisma-adapter/src/deferred.ts

export type Deferred<T> = {
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
};

export function createDeferred<T>(): [Deferred<T>, Promise<T>] {
  const deferred = {} as Deferred<T>;
  return [
    deferred,
    new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    }),
  ];
}
