import { type ApiRequest, type ApiResponse } from '../src/http.js';
/**
 * GET /api/health — deployment readiness.
 *
 * Public, so the UI can tell you what is wrong before you have a token. It
 * reports only whether things are *configured*, never their values, so an
 * unauthenticated caller learns nothing exploitable.
 *
 * When TRACKER_UPSTREAM_URL points at a persistent tracker, its health is
 * included too.
 */
export default function handler(req: ApiRequest, res: ApiResponse): Promise<void>;
