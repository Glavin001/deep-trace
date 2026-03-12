/**
 * Client-side instrumentation — runs before React loads.
 *
 * In Next.js 15.3+, this file is automatically loaded before React,
 * which is required for bippy to intercept the React DevTools hook.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { initReactInstrumentation } from '../../src/react-fiber-extractor';

// Initialize React fiber instrumentation via bippy.
// This must happen before React loads to install the DevTools hook.
initReactInstrumentation();
