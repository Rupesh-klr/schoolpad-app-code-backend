/**
 * ESM alias for app.cjs, so `node app.js` works as well as `node app.cjs`.
 *
 * The implementation lives in app.cjs because a host may `require()` the entry,
 * and Node only supports require() of an ES module from 22.x — this project's
 * host runs 20.x. Importing CommonJS from ESM works on every version, so the
 * alias is safe in this direction but not the other.
 */
import './app.cjs';
