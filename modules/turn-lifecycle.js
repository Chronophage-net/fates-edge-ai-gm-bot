'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
let generation = 0;
let queue = { size: 0, tail: Promise.resolve() };
const active = new Set();
const rawValues = new WeakMap();
// Do not persist turn-bound proxies in campaign state or method arguments.
function unwrap(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (rawValues.has(value)) return unwrap(rawValues.get(value), seen);
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) {
      const raw = unwrap(value[key], seen);
      if (raw !== value[key]) value[key] = raw;
    }
  }
  return value;
}
function check(scope = storage.getStore()) {
  if (scope && (scope.controller.signal.aborted || scope.generation !== generation)) {
    throw Object.assign(new Error('Turn cancelled or expired'), { name: 'AbortError' });
  }
}
function invalidate() {
  generation++;
  queue = { size: 0, tail: Promise.resolve() };
  for (const scope of active) scope.controller.abort();
}
function run(work) {
  const current = queue;
  if (current.size >= 20) return Promise.reject(new Error('GM turn queue is full; please try again shortly.'));
  const scope = { generation, controller: new AbortController() };
  current.size++;
  const result = current.tail.then(() => storage.run(scope, async () => {
    check(); active.add(scope);
    try { const value = await work(); check(); return value; }
    finally { active.delete(scope); }
  })).finally(() => { current.size--; });
  current.tail = result.catch(() => {});
  return result;
}
async function deadline(work, ms) {
  const parent = storage.getStore();
  check(parent);
  const scope = { generation: parent?.generation ?? generation, controller: new AbortController() };
  const abort = () => scope.controller.abort();
  parent?.controller.signal.addEventListener('abort', abort, { once: true });
  active.add(scope);
  let timer;
  try {
    return await storage.run(scope, () => Promise.race([
      Promise.resolve().then(() => { check(); return work(); }).then(value => { check(); return value; }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        abort(); reject(Object.assign(new Error('Tag processing deadline exceeded'), { name: 'AbortError' }));
      }, ms); }),
    ]));
  } finally {
    clearTimeout(timer); active.delete(scope);
    parent?.controller.signal.removeEventListener('abort', abort);
  }
}
// Guard context access, writes and async results. This prevents expired tag
// passes from continuing after awaited work; already committed writes cannot
// be rolled back and must not be blindly retried.
function guard(value, scope = storage.getStore(), cache = new WeakMap()) {
  if (!scope || !value || typeof value !== 'object') return value;
  if (cache.has(value)) return cache.get(value);
  const proxy = new Proxy(value, {
    get(target, key) {
      check(scope);
      const item = Reflect.get(target, key, target);
      if (typeof item === 'function') return (...args) => {
        check(scope);
        const result = Reflect.apply(item, target, args.map(arg => unwrap(arg)));
        if (result?.then) return result.then(answer => { check(scope); return guard(answer, scope, cache); });
        check(scope); return guard(result, scope, cache);
      };
      return guard(item, scope, cache);
    },
    set(target, key, item) { check(scope); return Reflect.set(target, key, unwrap(item)); },
    deleteProperty(target, key) { check(scope); return Reflect.deleteProperty(target, key); },
  });
  cache.set(value, proxy); rawValues.set(proxy, value); return proxy;
}
function wait(promise, ms, fallback = null, strict = false) {
  const scope = storage.getStore();
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (!scope && !strict) return resolve(fallback);
      scope?.controller.abort();
      reject(Object.assign(new Error('Action timed out'), { name: 'AbortError' }));
    }, ms);
  })]).then(result => { check(scope); return result; }).catch(error => {
    check(scope);
    if (strict || error.name === 'AbortError') throw error;
    return fallback;
  }).finally(() => clearTimeout(timer));
}
module.exports = { run, invalidate, check, deadline, guard, wait, signal: () => storage.getStore()?.controller.signal };
