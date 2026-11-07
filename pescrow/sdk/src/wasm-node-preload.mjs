const target = globalThis;
if (target.self === undefined) target.self = target;
if (typeof target.addEventListener !== "function") {
  target.addEventListener = () => {};
  target.removeEventListener = () => {};
  target.postMessage = () => {};
}
