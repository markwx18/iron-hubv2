/* Cloudflare Pages Function for /box/*. All behaviour lives in src/worker.js, which the test suite
   drives directly; this only hands Pages' request to it.

   Why Pages and not a plain Worker (2026-10-09): Mark's home Xfinity network blocks every *.workers.dev
   address (its security filter answers for the name with a block page and an expired certificate),
   which is the very network the family submits from. *.pages.dev is not blocked. */
import { handle } from '../../src/worker.js';

export function onRequest(context) {
  return handle(context.request, context.env, () => Date.now());
}
