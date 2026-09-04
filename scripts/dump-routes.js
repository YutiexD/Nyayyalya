#!/usr/bin/env node
/**
 * Print the API's real route table, straight from the Express router stack.
 *
 * Documentation drift is invisible until someone follows a doc and gets a 404. This
 * exists so `docs/API.md` can be checked against ground truth rather than against a
 * grep of the route files — which cannot see mount paths, and gets confused when one
 * file exports several routers.
 *
 *   node scripts/dump-routes.js
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET ??= 'x'.repeat(48);
process.env.REFRESH_SECRET ??= 'y'.repeat(48);
process.env.QR_SECRET ??= 'z'.repeat(48);
process.env.MASTER_KEK ??= 'a'.repeat(64);

const { createApp } = await import('../backend/app.js');
const app = createApp();

/** Recover a router's mount path from the layer regexp Express built for it. */
function mountOf(layer) {
  const src = layer.regexp?.source ?? '';
  // Express 4 builds: ^\/api\/auth\/?(?=\/|$)
  const withoutAnchor = src.startsWith('^') ? src.slice(1) : src;
  const cut = withoutAnchor.indexOf('\\/?(?=');
  const body = cut === -1 ? withoutAnchor : withoutAnchor.slice(0, cut);
  return body.split('\\/').join('/');
}

const routes = new Set();

function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      const path = (prefix + layer.route.path).replace(/\/{2,}/g, '/');
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) routes.add(`${method.toUpperCase()} ${path}`);
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountOf(layer));
    }
  }
}

walk((app._router ?? app.router).stack, '');

for (const route of [...routes].sort()) console.log(route);
console.error(`\n${routes.size} routes`);
